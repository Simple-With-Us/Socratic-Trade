# Sharing market data with congress.trade (App A)

**Status:** implemented (2026-06-22); **prod Infisical `CONGRESS_SHARE_ENABLED=on` 2026-08-13**
(still requires `CONGRESS_TRADE_TOKEN`).  Code default remains off for local.  See
`src/lib/congress-share.ts`, `app/api/admin/congress-share/route.ts`, and the
hooks in `src/lib/market.ts` (after-scan) and `src/lib/scheduler.ts` (nightly).

**Shared contract package (2026-06-30):** outbound import payload types, origin tags, API path constants,
and runtime Zod schemas are imported from `@jaywedgeworth22/congress-trading-shared`, with local App B
code retaining only mapping logic and operational gates.

**Share envelope version (2026-10-23, ST-3853):** since `@jaywedgeworth22/congress-trading-shared`
v2.9.0 the sender stamps the shared `SHARE_PAYLOAD_SCHEMA_VERSION` on every outbound import POST body
(and App A resolves it with `resolveSharePayloadSchemaVersion`, warning on unsupported versions
without rejecting the payload).

**2026-06-25 additions (all default-OFF):**
- **Numeric analyst price targets** — `fundamentals[]`/`analyst[]` already ride the
  push via `marketQuoteToFundamentals`/`marketQuoteToAnalyst` (sourced from the scan's
  `MarketQuote`, gated `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`). Their analyst numeric
  price targets (`targetMean/High/Low/Median`) were `null`; they are now filled when
  the opt-in FMP price-target provider is on (`FMP_PRICE_TARGETS_ENABLED`) — the targets
  thread through the enrichment surface onto the quote and `marketQuoteToAnalyst` emits
  them. Off → they stay `null` (App A's columns are nullable).
- **Inbound return-path receiver** — `POST /api/admin/securities/import`
  (`src/lib/securities-import-auth.ts`, `app/api/admin/securities/import/route.ts`,
  `src/lib/db-securities-import.ts`). Lands App A's gap-fill push into a local EOD
  cache; bearer `APP_B_INGEST_TOKEN`, constant-time, default-closed. Outbound pushes
  now carry `origin: app-b` so the receiver can skip a round-trip of our own rows
  (no-echo guard). The local cache feeds an opt-in `fetchDailyOHLC` tier
  (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED`, density-guarded by
  `SECURITIES_IMPORT_MIN_BARS`). See the 2026-06-25 rollout note.
  Each push carries `x-push-id`.  The response is an idempotent receipt:
  that id, a delivered ack, a consumed ack, and `health`.  A retry of an
  `ok` receipt with the same payload returns that body and does not write the
  cache again.  The same ok id with a different payload is rejected with 409.
  A non-ok receipt is replaced on the next attempt with the same id.  `health`
  is `ok` only when the id and both acks are present.  A missing ack is
  audited (`peer_push_ack_missing`), recorded on the `congress-inbound-push`
  health lane, and paged on the first occurrence.  The latest receipt is
  `congressInboundPush` on `GET /api/ops/snapshot`.  See
  `docs/rollouts/2026-10-15-ct-push-receipt.md`.

## Why

This app ("App B") and `congress.trade` ("App A", a Cloudflare Worker backed by a
DB) both consume **Financial Modeling Prep (FMP)**, which has a *shared daily call
quota*. App A is the shared system-of-record for company reference + daily-close
data. To stop App A from spending that quota, App B forwards the reference + price
data it already has to App A's **idempotent** import endpoint; App A upserts
`securities_ref` / `spx_eod` / `price_eod` and recomputes per-trade performance
anchors for any imported ticker.

## Important sourcing note (differs from the original brief)

The integration brief assumed App B forwards FMP `/v3/profile` and
`/v3/historical-price-full` responses "right after each FMP call." **App B does
not call those endpoints.** Its only FMP usage is the fundamentals enrichment
cascade (`/stable/ratios-ttm`, `/stable/grades-consensus`,
`/api/v4/insider-trading`, `/api/v4/senate-trading` — see
`FmpEnrichmentProvider` in `src/lib/data-providers.ts`), none of which maps to
App A's `refs` / `spx` / `prices` schema.

The data App A wants comes from App B's **other** sources:

| App A field | App B source |
|-------------|--------------|
| `refs` (partial) | `MarketQuote` from the NASDAQ screener + enrichment cascade — `companyName`, `sector`, `industry`, `marketCap` only. No CIK/exchange/country/ipoDate/sicCode. |
| `prices[].closes`, `currentPrice` | `fetchDailyOHLC()` (`src/lib/history.ts`) — Massive → Tradier → Marketstack → Yahoo → Stooq cascade. |
| `spx` | `fetchDailyOHLC("^GSPC")`. |

App A only needs the **data**, not a particular vendor.  Forwarding App B's
Yahoo/Massive/Tradier-sourced closes keeps CT on the peer price path and off a
second Massive hop (ST retired direct FMP/Quiver/UW on 2026-08-04).  The trigger
therefore shifts from "after each paid-vendor call" to **(a)** an after-scan refs
hook and **(b)** a nightly daily-close/SPX batch.

## What gets sent, and when

1. **After each market scan** (`scanMarket` in `src/lib/market.ts`):
   `shareScanRefs(scan)` forwards the candidate company `refs` (ticker,
   companyName, sector, industry, marketCap; `assetClass: "equity"`). Fire-and-
   forget, self-guarded, and **per-symbol throttled** (default 6h) so frequent
   scans never spam the endpoint. On a failed POST the throttle is rolled back so
   the next scan retries.

2. **Nightly batch** (`runCongressDailyShareIfDue` from the scheduler tick, at
   most once per UTC day): collects the **union of every user's watchlist symbols
   + policy-universe symbols** (the same set the filing-ingest job uses), fetches
   each ticker's daily closes (reusing the history cache) plus the `^GSPC` series,
   and POSTs them as `prices` + `spx` in capped chunks.  On scheduled runs it also
   POSTs `fundamentals[]` + `analyst[]` for that universe from the durable
   `symbol_field_latest` store (`buildFundamentalsAndAnalystImport`), so App A's
   fundamentals/analyst streams stay fresh even when the scan hook is throttled or
   scan candidates lack slow enrichment on a given run.

`refs` come from the scan hook; the nightly batch sends `prices` + `spx` plus
insider/short-volume and (when enabled) fundamentals/analyst from the field store.

**Round-2 additions (2026-06-22):** the nightly batch also forwards App B's two highest-fit datasets,
sourced from its cached web-sources and built by `buildInsiderImport()` / `buildShortVolumeImport()`:
- `insider[]` — `{ ticker, date, sentiment, buyFilings, sellFilings, buyShares, sellShares, owners[] }`
  from the SEC Form-4 dataset.
- `shortVolume[]` — `{ ticker, date, ratio, elevated }` from the FINRA daily short-volume dataset.
- `prices[].closes` now also carry `volume` (App A added a `volume` slot; open/high/low stay App B-only).

These ride in the first POST of the nightly batch (with `spx`). Read back via App A's
`GET /api/market/insider/{T}` and `GET /api/market/short-volume/{T}`.

**Round-3 additions (2026-06-24):** the **after-scan hook** (`shareScanRefs`) now also forwards
`fundamentals[]` + `analyst[]` for the scanned candidates — built by `marketQuoteToFundamentals` /
`marketQuoteToAnalyst` from the `MarketQuote` data the scan already fetched (no extra FMP calls), so App A
can skip its own FMP fundamentals/analyst pulls. Shapes match App A's PR #46 import slots
(`fundamentals: {ticker,date,peRatio,eps,beta,dividendYield,week52High,week52Low,fcfYield,debtToEquity,epsGrowth}`;
`analyst: {ticker,date,rating,strongBuy,buy,hold,sell,strongSell}` — App B has no price targets, so those
are omitted). Sent in the same throttled scan-hook POST as `refs`, but **gated behind
`CONGRESS_SHARE_FUNDAMENTALS_ENABLED` (default off)** and **held until App A confirms its #46 migration is
applied** — App A's tables don't exist until then, and pushing those rows early *errors them* on App A
(the rest of the import is unaffected). `refs` keep flowing regardless; flip the flag on after App A pings.

## Safety / gating

- **Default OFF.** Automatic forwarding (both hooks) runs only when
  `CONGRESS_TRADE_TOKEN` is set **and** `CONGRESS_SHARE_ENABLED` is on
  (`isCongressShareAutoEnabled()`).
- The token is a **server-only** secret (App A's `ADMIN_TOKEN`/`INGEST_TOKEN`).
  It is read from `process.env` only and never reaches the browser or any
  dashboard snapshot. No unauthenticated write path is exposed.
- Every outbound call is self-guarded (timeout + try/catch) and **never throws**
  into a scan or scheduler tick.
- **POSTs are kept small and split per dataset** (prod hardening, 2026-06-24): App A's per-call work
  (row upserts + per-trade perf recompute) blew the timeout on big bundled payloads, so the nightly
  batch now sends `spx`, `insider` (≤500/POST), `shortVolume` (≤500/POST), and `prices` (chunked by a
  5,000-close budget + ≤100 tickers/POST) as **independent** bounded requests, caps each symbol's
  history to ~1y (`CONGRESS_SHARE_MAX_CLOSES_PER_TICKER`, default 260 — App A backfills deeper itself),
  and uses a 30s per-POST timeout (`CONGRESS_SHARE_TIMEOUT_MS`). Errors log the per-dataset `sent` counts
  for diagnosis.
- A persisted marker (`congress-share:lastDailyRunDate`) makes the nightly batch
  idempotent per UTC day.
- **Auth circuit breaker** (prod incident 2026-09-07, 3,096 silent HTTP 401s over 9 days): an
  HTTP 401/403 from App A means the shared bearer token is wrong on one side — a permanent
  condition until an operator rotates/resyncs it, not a transient blip. This trips a durable
  breaker (`CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS`, default 6h) that short-circuits every
  subsequent call — the scan-hook, the rest of an in-flight nightly batch, and the ENTIRE
  collection phase (App A price-needs, OHLC fetches, screener refs) of the next nightly run —
  with no network call, until the cooldown elapses. Every absorbed call still replays into
  `api_health_log` (service `congress-share`) so the existing 5-consecutive-failure Sentry/
  degraded-health threshold is still reached at the caller's normal cadence. The breaker stores a
  non-secret fingerprint of the token that tripped it and auto-clears the moment
  `CONGRESS_TRADE_TOKEN` is resynced to a different value, so an operator fix does not have to
  wait out the rest of the cooldown. Once the cooldown elapses, exactly one caller's real probe is
  allowed through (an atomic durable claim serializes overlapping callers); success clears the
  breaker, a repeat 401/403 re-trips it for another full cooldown. A non-auth failure (5xx/
  timeout/network) never trips the auth breaker.  A separate in-memory upstream breaker
  (`CONGRESS_SHARE_UPSTREAM_BREAKER_FAILURES`, default 3 exhausted calls,
  `CONGRESS_SHARE_UPSTREAM_BREAKER_COOLDOWN_MS`, default 10 minutes) holds repeated HTTP 500
  and network failures.  While it is cooling, import POSTs and the token probe skip the network
  with no health replay, and the nightly run returns before price-needs and OHLC.  Price-needs
  500s do not count toward it.  The token probe is `GET /api/export/capabilities` (same bearer,
  no D1 scan).  `GET /api/export/price-needs?limit=0` is not a cheap probe: App A rewrites a
  non-positive limit to 500 and always runs unbounded summary SQL, and an uncaught D1/CPU error
  from that handler is HTTP 500.

## Congressional price-needs (performance vs S&P)

App A exposes `GET /api/export/price-needs` (same `INGEST_TOKEN` as import). The nightly
share **always** pulls a page of those tickers and merges them ahead of the monitored
universe so congressional trades missing `tx_performance` anchors get prices first.
Tickers flagged `needsDeepHistory` are sent with **full** history (not the ~1y nightly cap).

Ops one-shot deep backfill:

```http
POST /api/admin/congress-share
{ "fromAppANeeds": true, "fullHistory": true }
```

Optional: `CONGRESS_SHARE_PRICE_NEEDS_LIMIT` (default 500).

## Manual trigger (ops)

`POST /api/admin/congress-share` (admin-gated via `requireAdmin`) runs the batch
immediately, bypassing the once-per-day cadence. Requires `CONGRESS_TRADE_TOKEN`
(returns 400 otherwise) but **not** `CONGRESS_SHARE_ENABLED`.

- Body `{}` → share the monitored universe (watchlists + policy universes), recent-capped.
- Body `{ "symbols": ["AAPL","MSFT"] }` → share only those tickers (a targeted
  test that does **not** advance the daily marker).
- Body `{ "fullHistory": true }` (optionally with `symbols`) → **deep-history backfill**: send each
  symbol's FULL series (uncapped, still chunked into small POSTs) so App A can compute performance back
  to old trade dates. Run once / after adding symbols; the recurring nightly run stays recent-capped.
  See `docs/congress-trade-data-plan.md`.

Response echoes a summary: `{ ok, tickers, priced, spxRows, posts, failedPosts,
sent, responses, autoEnabled }`, where `responses` carries App A's per-POST
`{ ok, refs, spxRows, pricedTickers, priceRows, perfTickers, errors }`.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `CONGRESS_TRADE_TOKEN` | — | App A bearer token. Blank → all forwarding disabled. |
| `CONGRESS_TRADE_BASE_URL` | `https://congress.trade` | App A base URL (override for staging/local). |
| `CONGRESS_SHARE_ENABLED` | `off` | Master switch for the automatic hooks (needs the token too). |
| `CONGRESS_SHARE_MAX_TICKERS` | `2000` | Cap on the nightly universe. |
| `CONGRESS_SHARE_CONCURRENCY` | `4` | Parallel history fetches in the nightly batch. |
| `CONGRESS_SHARE_REF_TTL_MS` | `21600000` (6h) | Per-symbol scan-refs throttle. |
| `CONGRESS_SHARE_TIMEOUT_MS` | `15000` | Per-POST timeout. |
| `CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS` | `21600000` (6h) | Auth circuit-breaker cooldown after an HTTP 401/403 (see Safety / gating above). |

## Reverse direction (App A pulls App B — implemented 2026-07-31)

App A can now PULL App B's EOD bars over HTTP (cache-aside primary price source), token-gated with
the same `APP_B_INGEST_TOKEN` bearer as `/api/admin/securities/import`
(`verifySecuritiesImportToken`; middleware passes bearer requests through to exactly these two paths):

- `GET /api/market/prices/{symbol}?from=YYYY-MM-DD&to=YYYY-MM-DD` → the shared-package
  `PriceSeries` envelope: `{ ticker, closes: [{date, close, volume?}, ...], currentPrice,
  currentPriceDate }`. Closes are DESCENDING (closes[0] = latest); `from`/`to` optional, inclusive
  (default ~1y back → today); `currentPrice` is the newest close of the FULL series
  (range-independent). Unknown symbol / empty range → 200 with `{ ticker, closes: [] }`.
  App A treats that 200 as "this source has nothing" and only tries the next provider on non-200.
  A series whose newest close is older than the latest completed US equity session is HTTP 502
  `{ ok: false, error: "stale" }`.  An empty 200 would suppress that fallback.  The nightly push
  drops that ticker and the S&P series instead of POSTing them, and writes a
  `congress_share_stale_price_withheld` audit row.
- `GET /api/market/spx?from=&to=` → `{ closes: [...] }` DESCENDING, from SPY daily bars (the
  benchmark convention App A already uses).  No bars is 200 `{ closes: [] }`.  A stale SPY tail
  is the same 502.

Bars come from the canonical `fetchDailyOHLC` cascade (Massive keyed first, ~30min in-process
cache) — see `src/lib/market-read.ts` and `docs/rollouts/2026-07-31-market-read-routes.md`.

App A also exposes public, no-auth reads (e.g.
`GET https://congress.trade/api/analytics/ticker/{TICKER}` → a `ref` object) that
App B could consume to avoid its own lookups. Out of scope for this change.

## Tests

`test/congress-share.test.ts` (25 cases): mappers, `chunkPrices` budgeting/
truncation, the low-level POST (auth headers, body shape, skip-on-no-token, HTTP/
transport errors never throw), the scan-refs throttle + failure rollback, the
auto-enable gate, the once-per-day date gate, and the nightly batch over custom
symbols.

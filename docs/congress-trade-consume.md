# Consuming congress.trade (App A) data — the receiving side

**Status:** implemented (2026-06-22); **defaults updated 2026-08-04** —
`CONGRESS_TRADE_AS_CONGRESS_SOURCE` and `CONGRESS_ANALYTICS_ENABLED` default **ON**
(congressional data from App A). **Fundamentals** stay on Socratic's multi-provider
cascade (Yahoo / Finnhub / ROIC / SEC / …) — `CONGRESS_TRADE_FUNDAMENTALS_ENABLED`
default **OFF**. Price/history cache-aside (`CONGRESS_TRADE_READS_ENABLED`) default OFF.
Complements the push side (`docs/congress-trade-share.md`) and the push contract App A
implements (`docs/push-to-app-b.md`).

App A (congress.trade) is the system-of-record for congressional disclosures. App B
**must not** call FMP / QuiverQuant / Unusual Whales directly (owner 2026-08-04).
Flag-gated paths:

**Shared contract package (2026-06-30):** read-side App A/B types, API path constants, and runtime Zod
schemas are imported from `@jaywedgeworth22/congress-trading-shared`. Local aliases remain only for
backward-compatible App B naming.

## 1. Cache-aside market reads (`CONGRESS_TRADE_READS_ENABLED`)
`src/lib/api-clients/congress.ts` reads App A's public endpoints (`/api/market/bundle|ref|refs|prices|spx`).
Wired as the **first tier** of `fetchDailyOHLC` (`src/lib/history.ts`): App B reuses App A's EOD closes
before calling its own keyed history providers (Massive/Tradier/Marketstack), saving that quota. `^GSPC`
flows through the same path via `/api/market/spx`.

- App A's `closes` now include `volume`, so App B's bars carry close+volume (still no open/high/low).
- **Tradeoff:** App A returns close(+volume) only, so an enabled price chart renders a line (no candles)
  on App A cache hits. Contained to opt-in; default off → existing OHLC behavior unchanged.
- Self-guarded: disabled / miss / non-2xx / transport error → returns null → the cascade falls through to
  App B's own providers. No exceptions escape into a scan.
- App A's `ref` fields (sector/industry/marketCap) are still **not** wired into the cascade — they're
  already free-sourced via Yahoo in App B, so they'd be marginal value. (Fundamentals/analyst ARE now
  wired — see §1b.)

## 1b. Fundamentals / analyst read-back tier (`CONGRESS_TRADE_FUNDAMENTALS_ENABLED`)
> Gated by its **own** flag, **separate from** the price/history `CONGRESS_TRADE_READS_ENABLED` (§1), so
> enabling the price cache-aside does not silently give App A precedence over the direct fundamentals
> providers. Default OFF — an explicit, independent opt-in.

App A stores fundamentals + analyst consensus (its own enrichment + our donated push) and now serves them
at **`GET /api/market/fundamentals/:ticker`** and **`GET /api/market/analyst/:ticker`** (date-ascending
rows; `?from=&to=` like `/market/insider`). App B reads them via `getAppAFundamentals` / `getAppAAnalyst`
(`src/lib/api-clients/congress.ts`), surfaced through the **`CongressTradeEnrichmentProvider`** in
`src/lib/data-providers.ts`, registered ahead of the paid fundamentals providers (Finnhub/FMP/…) so App A's
free, already-stored values win those fields. Maps onto existing `SymbolEnrichment` fields
(peRatio, eps, beta, dividendYield, fiftyTwoWeekHigh/Low, fcfYield, debtToEquity, epsGrowth,
targetMean/High/Low/Median, analystRating/Score/BySource) — **no new field**, so no multi-site plumbing.

- **Caching:** reads go through the same 6h enrichment cache as the other slow-moving providers
  (`readEnrichmentCache`/`writeEnrichmentCache`, prefix `congress.trade`), so repeated scans don't re-hit
  App A. **Misses are negative-cached** for 1h (an empty entry) so an uncovered symbol isn't re-fetched
  from both endpoints on every back-to-back scan.
- **Freshness guard:** an App A row is used only if its `updatedAt`/`date` is within
  `CONGRESS_TRADE_MAX_STALE_DAYS` (default 21). Stale rows fall through so they never override fresh paid data.
- **Rating-only rows** still surface: when App A has a `rating` label but no buy/sell counts, the provider
  derives a score (`scoreFromAnalystLabel`) and writes `analystBySource`, which is what the cascade blends
  into the displayed rating.
- **Deeper saving — the opt-in coverage hint (`ENRICHMENT_SHORT_CIRCUIT_ENABLED`):** when this flag AND
  `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` are on, the cascade runs the **free** providers first to learn what App A
  already covers, then runs the **paid** providers over the **same** symbols but hands each one an
  `EnrichmentContext` — a per-symbol set of the `SymbolEnrichment` fields App A already filled. A paid
  provider uses it to skip only the redundant **sub-calls** that would re-fetch already-covered fields,
  **without skipping the whole provider** — so the fields it *uniquely* supplies still come through.
  Concretely, FMP makes four independent calls per symbol (`ratios-ttm` → P/E, `grades-consensus` →
  analyst, `insider-trading`, `senate-trading`); when App A already has P/E + analyst it skips the first
  two and still fetches insider/senate. **Nothing is lost** — only duplicate upstream calls are
  eliminated. (The earlier design skipped the *entire* paid provider for "covered" symbols; that silently
  dropped the news/sentiment, insider/senate, and quote fields those bundled providers also supply, so it
  was replaced — see the rollout note.) Paid providers are tagged `costTier: "paid"`; ones that ignore the
  hint behave exactly as before; the merge stays in registration order so field precedence is unchanged.
  **Default OFF** — when off the cascade runs every provider over every symbol with no hint, exactly as
  before. (Operational alternative, no flag: with App A trusted, drop a redundant paid fundamentals
  provider from the cascade entirely — accepting you also forgo that provider's unique fields.)

## 2. App A as the congressional source (`CONGRESS_TRADE_AS_CONGRESS_SOURCE`)
When on, `refreshCongress` (`src/lib/web-sources/congress.ts`) swaps its scraper cascade (Senate eFD /
Apify / Capitol Trades) for a single App A adapter, `fetchAppACongressTrades`, that pulls App A's
**public** `/api/transactions` feed (no token). The feed is **oldest-first by `cursor_seq`
(insertion order, NOT trade-date order)**, so the pull bounds the window server-side with
`?from=<today − (signal window + 7d)>` (App A's documented rolling-window param) and pages forward via
`cursor` until the window is exhausted (page/row capped). `coerceCongressTrade` maps App A's confirmed
fields (`ticker→symbol`, `memberName/fullName→member`, `txType` `P`→buy / `S`,`S_partial`→sell,
`amountMin/Max`, `owner`, `txDate→tradedAt`, `filedDate→disclosedAt`; `filedDate` may be null → falls
back to `txDate`) and rejects unparseable dates. A 0-result pull keeps the prior dataset (never wipes).

> **Do not enable this flag until App A's feed carries CURRENT disclosures.** As of 2026-06-22 App A's
> `/api/transactions` is still seed/historical (mostly 2012–2020; `from=2026-01-01` → `total:1` with a
> null ticker). Switching the source now would replace App B's working scrapers (which fetch current
> disclosures) with stale data — a regression. The flag + `from=` pull are validated live; just keep it
> OFF until `GET /api/transactions?from=<today-7d>` returns real recent rows.

## 3. App A analytics overlay — the "Trends" composite (`CONGRESS_ANALYTICS_ENABLED`)
App A computes aggregate congressional analytics App B can't derive from raw trades — its public
"Trends" page (dollar-weighted net flow, distinct-member counts, cluster buys, member track-record).
`src/lib/web-sources/congress-analytics.ts` refreshes these daily (`getAppATickerLeaderboard` +
`getAppAClusterBuys` + `getAppAMemberLeaderboard`, `?window=90d`), persists a per-symbol overlay, and
`getSymbolWebSignals` attaches it as `SymbolWebSignal.congressAnalytics`. `outlierInterestScore`
(`market.ts`) then folds it into scan candidate selection through the capped Congress.Trade composite:
only strong, supported BUY composites can surface a below-cutoff name. Weak/proxy-only analytics remain
evidence context and do not promote candidates. Net-selling/neutral contributes 0 to long-side outlier
selection. Additive + default-off → no behavior change when off.

**Member quality — real skill, with an activity fallback (2026-06-25).** App A now exposes
`GET /api/analytics/member/:filerId/performance` → `{performance:{tradeCount, scoredCount, winRate,
medianReturn, medianExcess, avgReturn, avgExcess}}`, where `avgExcess`/`medianExcess` are realized
return **in excess of the S&P** (alpha). `buildMemberSkillScores` (in `congress-analytics.ts`) fetches
this for the filerIds surfaced in cluster `topMembers` (bounded by `MAX_SKILL_LOOKUPS=200`,
`getAppAMemberPerformance` in the read client) and rank-normalizes by alpha (→ 0–100, keyed by
**filerId**), ranking only members with `scoredCount > 0`. The cluster `topMemberScore` prefers this
real skill score and **falls back** to `buildMemberScores` (activity prominence — `estVolumeUsd`/
`tradeCount`, keyed by name) when a member has no scored performance yet. App A returns nulls until a
member's trades are scored (which needs the price push to fill in), so this lights up gradually — until
then the activity proxy carries it. No extra calls when there are no clusters.

**New App A analytics endpoints (2026-06-25, App A PRs #77/#79/#80).** Three additional read functions
wired into `src/lib/api-clients/congress.ts` (all gated on `CONGRESS_ANALYTICS_ENABLED`):

- **`getAppAConviction(opts)`** → `GET /api/analytics/conviction?window=&limit=` — composite 0–100
  conviction score per ticker (`convictionScore: number | null`, direction-aware BUY/SELL). `null` = thin
  signal (< 3 resolved-side trades); these rows are **excluded** from the overlay map so no-signal tickers
  can't leak into scan candidates via `netSentiment`. Wired into `refreshCongressAnalytics` alongside the
  existing leaderboard fetch; `CongressAnalytics` gains `convictionScore`, `convictionDirection`, and
  `convictionFallback`.

- **`getAppATickerBacktest(ticker, opts)`** → `GET /api/analytics/ticker/{T}/backtest` — per-horizon
  post-buy return stats (`winRate`, `medianReturn`, `medianExcess`, `n`). On-demand only (one call per
  ticker — too expensive to bulk-fetch in the daily refresh); intended for proposal/chat enrichment.

- **`getAppAConflicts(opts)`** → `GET /api/analytics/conflicts?window=&limit=&chamber=&party=` —
  committee-sector overlap context (member sits on a committee mapped to the traded stock's GICS
  sector). Aggregated to `conflictCount` per ticker in the overlay. This is context only, not a legal
  conclusion or accusation of wrongdoing. Conflict-only tickers (absent from leaderboard and conviction)
  still get an overlay entry.

**Composite score + validation harness (2026-06-27).** App B now folds the App A overlay into a
direction-aware Congress.Trade composite (`src/lib/congress-score.ts`) with conviction, member/cluster
breadth, member skill, estimated flow, disclosure freshness, coverage quality, and committee-sector
overlap context. BUY scores can surface long-side outlier candidates only when the capped composite is
strong and supported by breadth/flow/cluster/skill evidence; SELL scores are preserved as signed
evidence but do not create long candidates. Coverage confidence is persisted and caps the final score,
so one thin but impressive-looking input cannot dominate Market Scan context. The score is stamped onto
`MarketQuote` and persisted in `signal_snapshot` via `CandidateEvidence`, so forward runs can mature
into rank-IC/quantile/spread evaluation. Historical/export evaluation lives in
`src/lib/congress-score-eval.ts` and `npm run eval:congress-score`; see
`docs/congress-score-evaluation.md` for metrics, go/no-go gates, and the App A export contract needed
for honest historical validation.

For the export, member skill should be split by filing-date basis vs trade-date basis, buy vs sell
direction, and 1/3/6/12m horizon. Include `filingAlpha`, `tradeAlpha`, and `decayRatio` so App B can
evaluate whether the edge survives the disclosure lag rather than inheriting a whole-history leaderboard.
The App B evaluator now accepts App A PIT rows directly, including nested `labels.horizons[]`,
cursor-paged exports, and `baselines.appBPreCongressScanScore` / `preCongressScore` for marginal IC.
For PIT rows, App B anchors observations to `asOf` / disclosure availability, rejects labels whose
entry date precedes availability, ignores top-level returns when nested horizon labels are present,
requires `signedScore` or `direction`, and rejects member-skill inputs whose vintage is after `asOf`.
After App A PR #96, App B also honors `validationReadiness` and `pitValidity`: an export envelope with
`historicalValidationReady=false` exits `2` without evaluation, and rows marked unsafe/not-ready are
dropped. This keeps reconstructed/history-seeded rows useful for contract testing without letting them
become validation truth.

## 4. Push receiver — webhook + SSE
App A pushes events (see `docs/push-to-app-b.md`); both transports feed the same handler,
`applyCongressEvent` (`src/lib/congress-trade-events.ts`), which upserts into App B's existing persisted
web-source datasets so the scan's `getSymbolWebSignals` overlay serves them unchanged.

- **Webhook:** `POST /api/webhooks/congress`, bearer-verified constant-time against `CONGRESS_WEBHOOK_SECRET`
  (`src/lib/congress-webhook-auth.ts`; default-closed when unset). Accepts one envelope or `{events:[...]}`.
- **SSE (App A subscription model — repaired 2026-07-01):** `src/lib/congress-stream.ts` connects out to
  App A's `/api/stream`, which **requires** `?subscription=<id>` and a per-subscription secret. The
  consumer resolves a subscription — operator-provisioned via `CONGRESS_STREAM_SUBSCRIPTION_ID` +
  `CONGRESS_STREAM_SUBSCRIPTION_TOKEN`, or auto-created against App A's public `POST /api/subscriptions`
  when `CONGRESS_STREAM_AUTO_SUBSCRIBE` is on — then connects with `?subscription=` + the secret as
  `Authorization: Bearer`. App A emits `event: trade.new` with the **raw Transaction** as data; the
  consumer maps it explicitly into a `congress.trade` envelope (`toCongressEventEnvelope`) before
  `applyCongressEvent`, and treats `cursor`/`ping`/`reconnect`/`error` as recognized control frames (no
  per-heartbeat "dropped unparseable" noise). Tested incremental frame parser, reconnect/backoff, and
  `Last-Event-ID` resume. Started from `startStreams()` when `CONGRESS_STREAM_ENABLED` is on; **inert**
  until a subscription is provisioned. **Flap policy (2026-08-17, #2550):** connect abort at 8s;
  backoff resets only after the stream has lived 30s; five short-lived connects in 10 minutes jump
  to a 5-minute cap; disconnects log `soft: true` so they cannot hard-STOP the lane or bury the
  console Attention list. HTTP reads fail fast with `AbortError` when the congress.trade p50 is
  already > 2s. (Before the 2026-07-01 fix the consumer connected without `?subscription=`,
  so App A returned `400 missing ?subscription=` and the push path never connected.)
- **Idempotency:** events deduped by `id` (bounded in-memory set). `congress.trade` → `upsertCongressTrades`
  (deduped + pruned to 120d); `insider.update` → raw Form-4 filings *or* a precomputed `insiderSentiment`
  scalar (synthesized into a marker filing); `ref.upsert`/`price.eod`/`spx.eod` are acknowledged no-ops
  (App B consumes those lazily via the read client).

## Config (all default off)
| Env var | Purpose |
|---------|---------|
| `CONGRESS_TRADE_READS_ENABLED` | cache-aside market reads (price/history tier, §1) |
| `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` | the fundamentals/analyst enrichment tier (§1b), gated separately from price reads; default off |
| `CONGRESS_TRADE_MAX_STALE_DAYS` | freshness cap (default 21) for App A fundamentals/analyst rows before they fall through to paid providers |
| `ENRICHMENT_SHORT_CIRCUIT_ENABLED` | hand paid providers a per-symbol coverage hint so they skip only the redundant sub-calls App A already covers (e.g. FMP's P/E + analyst + price-target calls) while still fetching their unique fields; no whole provider is skipped (needs `CONGRESS_TRADE_FUNDAMENTALS_ENABLED`); default off |
| `CONGRESS_TRADE_AS_CONGRESS_SOURCE` | source congressional trades from App A instead of scrapers |
| `CONGRESS_WEBHOOK_SECRET` | shared bearer App A presents to the webhook (default-closed when blank) |
| `CONGRESS_STREAM_ENABLED` | start the outbound SSE consumer |
| `CONGRESS_TRADE_BASE_URL` | App A base (shared with the push side) |
| `CONGRESS_TRADE_READ_TOKEN` | optional bearer for App A reads (reads are public); also the fallback SSE subscription secret |
| `CONGRESS_STREAM_PATH` | App A SSE path (default `/api/stream`) |
| `CONGRESS_STREAM_SUBSCRIPTION_ID` | operator-provisioned App A SSE subscription id (added to `?subscription=`) |
| `CONGRESS_STREAM_SUBSCRIPTION_TOKEN` | that subscription's secret (sent as `Authorization: Bearer`); also the desired secret when auto-creating |
| `CONGRESS_STREAM_AUTO_SUBSCRIBE` | when no subscription id/token is set, auto-create one via App A's public `POST /api/subscriptions` (default off) |
| `CONGRESS_STREAM_CLIENT_ID` | clientId used when auto-creating a subscription (default `app-b`) |

## Status of App A's endpoints (2026-06-22)
App A's round-2 endpoints are **merged** and go live after its next deploy (a pending prod DB migration).
**Wait until `GET https://congress.trade/api/health` returns `{"db":true}` before enabling the flags.**
Until then every consume path self-guards / falls through, so enabling early is harmless but inert.

Confirmed contract deltas applied here: the `/api/transactions` feed is **public** (no token); `closes`
carry `volume`; and App B's nightly push now sends `insider[]` + `shortVolume[]` (App A added those import
slots) — see `docs/congress-trade-share.md`.

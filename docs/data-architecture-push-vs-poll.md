# Data Architecture: Push vs. Poll, and Compute-vs-Source

Durable principles for how this app ingests data and where it spends compute. Captured so we
don't re-derive them. Two ideas run through everything here:

1. **Push beats poll when the source emits discrete events** — get data the moment it exists
   instead of repeatedly asking "anything new?" (like phone push notifications vs. checking
   email every 5 min).
2. **Source-it beats compute-it when a provider already returns the value** — but only when
   our version is an *approximation* or the value is *already in a payload we fetch*. A free
   local one-liner should stay local.

---

## Part 1 — Principles

### Push vs. pull: the three mechanisms

| Mechanism | Direction | Best for | In our app |
|---|---|---|---|
| **Webhook** | Provider → us (HTTP POST to a URL we host) | Discrete events (an alert, a filing) | ✅ TradingView → `app/api/webhooks/tradingview` |
| **WebSocket** | We dial out, hold a long-lived socket; provider streams | High-frequency streams (quotes, news, fills) | ✅ **Implemented** — Alpaca news and `trade_updates` WebSocket workers live in `src/lib/streams/` (started from `instrumentation.ts`). Massive/Finnhub quote streams still scoped below. |
| **SSE (server-sent events)** | One-way stream over plain HTTP | Server → our own browser clients | ✅ `app/api/events/stream` → dashboard |

**Why push reduces overhead:** less compute/parsing (process only on change), less bandwidth
(deltas not snapshots), fewer wasted API calls against rate limits, lower latency.

**Costs / when NOT to push:**
- Needs a public, authenticated endpoint (webhooks) — we have the `socratictrade.com`
  tunnel + the fail-closed shared-secret + dedup pattern (see the TradingView route).
- Delivery is at-least-once and unordered → **idempotency/dedup is mandatory**.
- The source must actually offer push. SEC filings, congressional disclosures, FRED macro,
  and FINRA short-volume are **batch-published** — they stay polls (you can only poll faster).
- WebSockets need a **persistent process** (our PM2 Node runtime), not a per-request handler,
  plus reconnect + gap-backfill logic.

### The relay / fan-out pattern ("one entity pulls, then pushes to others")

Yes — one service can poll a batch source (SEC, congress) once and **push** updates to many
subscribers. That's exactly what commercial data vendors are: **Polygon/Massive, Benzinga,
Finnhub, QuiverQuant, FMP poll/scrape the raw sources and then offer us webhooks/streams.**
So there are two ways to benefit:

- **Consume someone else's relay** (usually best): pay a vendor who already turns batch SEC/
  congress data into a real-time stream, instead of polling the raw source ourselves. (We
  don't today — our SEC/congress are self-polled; a paid real-time filing stream is the
  upgrade path if filing latency ever matters.)
- **Be our own relay** (only if we run many instances/users): one shared ingestion process
  polls the batch source once and **fans out** to N app instances/users over our own pub/sub,
  instead of each instance polling independently. Today we're single-process, so the in-process
  event bus (`src/lib/events.ts`) is the seed of this; a multi-host version would back it with
  Redis pub/sub or Postgres LISTEN/NOTIFY. **Caveat:** redistributing a vendor's data to others
  is usually a ToS/licensing issue (see the market-data sharing guardrails) — relaying *our own
  derived events* (run-complete, a fill) is fine; rebroadcasting raw vendor quotes is not.

### Shared cache fills and pending demand

For public OHLC facts, the app now tracks failed requests in `market_data_demands`.
If Alice asks for `XYZ` and no shared source can fill it, the miss is recorded for a
short TTL (`MARKET_DATA_PENDING_TTL_MS`, default 30 min). If Frank later triggers a
**shared** fill for `XYZ`, the cache now satisfies Alice's old miss on the next
refresh/retry and emits a `market-data` SSE event so open dashboards retry quickly.

This is deliberately not quota pooling:
- A shared/env-key/no-key cache fill may satisfy prior pending users.
- A private user-key fill does **not** satisfy other users unless
  `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on`.
- The SSE event does not include the symbol; it tells clients to refresh without
  leaking another user's watchlist intent.

### Compute-vs-source principle

Offload a computed metric to a provider **only** when:
- our version is an **approximation** the provider does better (e.g. keyword sentiment proxy → a
  real model score), **or**
- the value is **already sitting in a payload we fetch** (e.g. VWAP in the Massive bars).

**Keep computing in-house** when it's a **free one-line derivation** of data we already hold
(PEG, ROE, earnings yield) — fetching it would trade ~zero compute for a network call + a
dependency + cross-provider unit-mismatch risk — or when it's **bespoke / learning-critical**
(our composite technical score, the analyst cross-provider blend, full-universe breadth, the
VIX+curve regime classifier).

### The biggest lever isn't data push — it's event-driven *triggering*

LLM inference is our dominant compute cost, and the strategy run (proposal + per-proposal
red-team + every-run post-mortem) currently fires on a **fixed 60-min wall clock regardless of
whether any input changed**. The largest possible overhead reduction is to **trigger the LLM
pipeline when a material event arrives** (fresh 8-K, congress buy, fill, regime flip,
high-conviction technical push) rather than on the clock. This is **implemented and default-off**
(`src/lib/triggers.ts`; `TRIGGER_ENGINE=event|both` env var to enable); see the scoping section
below for details.

---

## Part 2 — Where it applies in *our* app

### Most of our polling is already cheap
One 60s scheduler tick (`src/lib/scheduler.ts`) gates everything; real cadences are long TTLs
(SEC/congress/FRED/FINRA = 24h, scan = 5min, news/breadth = 30min). The overhead is concentrated
in two places, which is where push pays off.

### Push candidates (ranked)
| Rank | Target | Mechanism | Status |
|---|---|---|---|
| 1 | Browser dashboard 30s poll (`/api/dashboard`) | **SSE** on run/order events | ✅ **Implemented** (`src/lib/events.ts`, `app/api/events/stream`, client EventSource; poll demoted to 120s fallback). Emits on `run-complete`; add `order`/`proposal` emits next. |
| 2 | News (Alpaca REST, 30-min poll) | Alpaca **news WebSocket** (free Benzinga) | ✅ **Implemented** — `src/lib/streams/alpaca-news-stream.ts`; deduped by article id; writes into the shared news cache. |
| 3 | Order fills/status (polled each run) | Alpaca **`trade_updates` WebSocket** | ✅ **Implemented** — `src/lib/streams/alpaca-trade-updates-stream.ts`; emits `order` dashboard events on fill/partial_fill. |
| 4 | Quotes (NASDAQ screener poll) | Massive/Alpaca/Finnhub **WebSocket** | Scoped below; Massive $29 stream is still 15-min delayed. |
| — | Technicals | TradingView **webhook** | Already push-capable; **currently `TECHNICAL_SOURCE=computed`** (free fallback) — TradingView wired but not in use. |

**Stay polled (no real push exists / batch sources):** SEC 8-K + insider (Atom feed, ~10-min
publish), FINRA short-volume (daily file), congress (Apify/eFD scrape), FRED macro, breadth
(daily aggregate). **Robinhood MCP is request/response only — no stream.**

### Compute-offload candidates
| Metric | Verdict | Status |
|---|---|---|
| **VWAP** | Source it — already in the Massive payload we fetch, was being dropped | ✅ **Implemented** — captured in `GroupedBar`/`GroupedDailyBar` + per-symbol `OHLCBar.vwap` (`massive.ts`, `history.ts`, `indicators.ts`), surfaced on the price chart, and merged into `/api/scan` rows as sortable `vs VWAP` when Massive grouped daily data is available. |
| **News sentiment** | Prefer real model score over keyword proxy | ✅ **Implemented** — cascade now overrides `scoreHeadlines` with Alpha Vantage's `NEWS_SENTIMENT` model score when present (`data-providers.ts`). |
| Raw technical indicators (rsi/sma/macd) | Keep ours; add Massive `/v1/indicators/*` as fallback when free-OHLC 429s | Not started (medium). |
| fcfYield / debtToEquity | In-house primary; FMP/Finnhub `*TTM` as backup when Yahoo inputs missing | Not started (low value). |

**Keep computing in-house (no offload):** composite technical score + named cross signals,
analyst cross-provider blend, all `derived-metrics.ts` ratios (PEG/ROE/Graham/rr52w),
full-universe breadth, market-regime classifier, all `macro-metrics.ts` spreads.

---

## Part 3 — Scoping the remaining push items

### #2 Alpaca news WebSocket (replaces the news poll)
- **Endpoint:** `wss://stream.data.alpaca.markets/v1beta1/news`, auth with the Alpaca key/secret
  we already have; same Benzinga feed as the REST `/v1beta1/news` we poll in
  `AlpacaNewsEnrichmentProvider`.
- **Work:** a persistent WS client (started from `instrumentation.ts`, lives in the PM2 process)
  that subscribes to `*` (or the scan watchlist), and on each article writes headlines into the
  same per-symbol cache the enrichment provider reads — so the scan keeps reading a cache and
  never blocks on the socket. Reconnect w/ backoff; dedup by article id.
- **Effort:** Medium. **Risk:** low (read-only, additive). Biggest infra step is "we now hold a
  long-lived outbound socket" — first time we do that.

### #3 Alpaca `trade_updates` stream (push fills)
- **Endpoint:** `wss://paper-api.alpaca.markets/stream` (or live), `listen` to `trade_updates`.
- **Work:** same persistent-worker pattern; on a `fill`/`partial_fill` event, update order state
  and `emitDashboardEvent({ type: "order" })` so the dashboard refreshes instantly, and
  optionally trigger reconciliation instead of waiting for the next run.
- **Effort:** Medium. Only relevant when the active broker is Alpaca (Robinhood MCP can't stream).

### #4 Quotes WebSocket
- **Endpoint:** Massive/Polygon `wss://...` (15-min delayed on the $29 tier), or Alpaca market-data
  WS (IEX free / SIP paid), or Finnhub trade WS (~50 symbols free).
- **Work:** persistent worker streaming the scan watchlist into the quote cache; lets us also
  compute advance/decline live.
- **Effort:** Medium–High. **Caveat:** at $29 Massive the stream is still delayed — it's push,
  not lower-latency. Lower priority than #2/#3.

### Shared pattern for #2–#4 (the WebSocket worker)
A single long-lived client module, started once in `instrumentation.ts`, that: connects out →
authenticates → subscribes → writes events into the existing **persisted-dataset-with-TTL**
caches the scan/enrichment already read → reconnects with backoff → dedups. This keeps the hot
read path (scan) decoupled from the socket. Inbound **webhooks** (provider → us) keep using the
serverless route pattern under `app/api/webhooks/<provider>/` instead.

### Event-driven LLM trigger (the big lever — implemented, default-off)
The trigger engine is built (`src/lib/triggers.ts`, `src/lib/regime-watch.ts`, and the SEC 8-K
`sec8k.ts` producer). It replaces the fixed 60-min strategy cadence with: run when material
events arrive (new filing / congress buy / fill / regime flip / high-conviction technical),
debounced and policy-gated (cooldown, max runs/hr, market-hours, conviction threshold).
**Default off**: `TRIGGER_ENGINE` unset → scheduler runs on the fixed interval exactly as before;
`submitMaterialEvent`/`broadcastMaterialEvent` are no-ops. Set `TRIGGER_ENGINE=event` or
`TRIGGER_ENGINE=both` to activate event-driven triggering.

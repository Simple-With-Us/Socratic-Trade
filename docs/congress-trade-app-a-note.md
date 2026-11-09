# App B ↔ App A coordination (congress.trade) — current state

Living coordination doc. Updated after App A confirmed round-2/3 status (2026-06-24).

## Where things stand
- App A's pipeline is **live and current**: `from=2026-03-26` (90d) → ~110 trades, `source:"primary"`,
  freshest filing ~2026-06-19. `ticker-leaderboard` / `cluster-buys` / `summary` light up at `?window=90d`
  (verified: real `estNetFlowUsd` / `netSentiment` per ticker).
- **App B can flip on now:** cache-aside reads, the congress source (`?from=today-90d`), and the analytics
  overlay (ticker net-flow / netSentiment / tradeCount). All default-off flags; verified against live App A.

## Two App-A gaps that gate the richer features (Codex's area, not App A-author's)
1. **`filer_id` is null on live rows** → `summary.uniqueMembers = 0`, `/member-leaderboard` empty,
   `/cluster-buys` empty. This — not a field name — is what blocks App B's **member-weighting** and the
   **cluster** boost. App B's code is wired and inert until member identity resolves.
2. **Ticker resolution ~66%** (improving). Null-ticker rows (e.g. Treasury bills) are simply skipped by
   App B's coercer, so this just means fewer usable rows until resolution improves.

## Member-weighting field (answered)
App A's member-leaderboard has **no** realized-performance metric — per-row numerics are
`tradeCount / buyCount / sellCount / uniqueTickers / estVolumeUsd / estNetFlowUsd / netSentiment`.
App B now rank-normalizes **`estVolumeUsd` (then `tradeCount`)** as a **prominence/conviction proxy**
(keyed by `fullName`), explicitly NOT a skill score. True skill-weighting needs either App A to expose
per-member realized performance, or App B to aggregate `/api/analytics/performance/:txId` per member —
**proposed future increment.** Inert until `filer_id` resolves.

## Things App B is now consuming / has fixed (from App A's note)
- **`fullName`** is the cluster `topMembers[]` name field (not `memberName`) — fixed.
- **`isOption`** — App B now **skips option disclosures** (P/S txType can't express call/put direction;
  equity-only signal).
- **`confidence`** (0–1 per row) — App B now **drops rows below a floor** (`CONGRESS_TRADE_MIN_CONFIDENCE`,
  default 0.3) to filter extraction noise.
- **SSE backlog** — confirmed already shipped (full-feed `cursor_seq > id` replay on `Last-Event-ID`,
  durable, gap-free). App B's SSE consumer already sends `Last-Event-ID`, so resume works now. ✅
- **`/performance/:txId`** exists (returns `{available:false}` until App B's nightly price push + App A's
  perf cron populate `price_at_trade`/`current_price`). **App B will consume it into its learning loop**
  once it lights up — next increment.
- **`refSector`/`refMarketCap`/`capGainsOver200`** are on every transactions row — App B can consume
  these next (low priority; sector is already free-sourced locally).

## Fundamentals/analyst push — BUILT (App A PR #46)
App A confirmed the import slots (PR #46, pending merge+migration). App B's after-scan hook now sends
both, built from `MarketQuote` data the scan already fetched (no extra FMP calls), matching App A's exact
shapes:
- `fundamentals: [{ ticker, date, peRatio?, eps?, beta?, dividendYield?, week52High?, week52Low?, fcfYield?, debtToEquity?, epsGrowth? }]`
- `analyst: [{ ticker, date, rating?, strongBuy?, buy?, hold?, sell?, strongSell? }]` (App B has no price
  targets → `targetMean/High/Low/Median`/`analystCount` left for App A to fill null)
Sent in the same idempotent scan-hook POST as `refs`, but **held behind `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`
(default off)** per App A's note that pushing these rows before #46's migration *errors them* (the rest of
the import is unaffected; `refs` keep flowing). **App A: ping when #46 is applied** — we flip the flag and
these start populating `securities_ref`. Macro/news deferred as agreed.

## FYI
App B populates App A via the nightly batch + App A's backfill (no per-read push-back). App B reads
`/api/market/prices`+`/spx`+`/transactions`+`/api/analytics/*`, not `/market/ref`/`/bundle`.

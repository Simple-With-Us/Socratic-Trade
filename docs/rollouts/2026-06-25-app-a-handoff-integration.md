# 2026-06-25 — App A handoff: conviction + conflicts + backtest endpoints + adjusted-close fix

## Summary

Implements the read side of the App A (congress.trade) handoff document (`1cdd5ecf-appBhandoff.md`):
three new analytics endpoints now consumable by App B, the conviction + conflict signals wired into
the daily analytics overlay, and a Yahoo adjusted-close fix so prices pushed to App A are
split+dividend-adjusted where the source provides them.

## Why

App A shipped or is merging four new analytics endpoints (#77 backtest, #79 conviction, #80 conflicts,
#84 bulk export). The handoff doc also flagged that App B should be sending **adjusted close** (not raw
close) so App A's multi-year return calculations are correct.

## What changed

### New App A read endpoints (`src/lib/congress-trade-client.ts`)

Three new interfaces + three new async functions (all gated on `CONGRESS_ANALYTICS_ENABLED`):

- **`getAppAConviction(opts)`** — `GET /api/analytics/conviction?window=&limit=`
  Returns `AppAConvictionTicker[]` with a composite 0–100 `convictionScore` (null = thin signal),
  `direction: "BUY"|"SELL"|null`, and component metadata. Hard caps on App A side: single-member ≤25,
  no realized-skill evidence ≤60.

- **`getAppATickerBacktest(ticker, opts)`** — `GET /api/analytics/ticker/{T}/backtest?window=&horizons=&filerId=`
  Returns `AppATickerBacktest` with per-horizon stats (tradeCount, n, medianReturn, winRate, medianExcess,
  avgExcess). Horizons with n < 5 report null stats. Available for on-demand caller use; not fetched
  during bulk refresh (one call per ticker → too expensive at scale).

- **`getAppAConflicts(opts)`** — `GET /api/analytics/conflicts?window=&limit=&chamber=&party=`
  Returns `AppAConflict[]` — per-trade flagged disclosures where member sits on a committee overseeing
  the stock's GICS sector. ETFs excluded. Educational/observational signal.

Also extended `analyticsQuery()` to pass `chamber` and `party` filter params.

### Analytics overlay (`src/lib/web-sources/congress-analytics.ts`)

- `refreshCongressAnalytics` now fetches conviction + conflicts in parallel with the existing 3 calls.
- Builds `convictionByTicker: Map<string, AppAConvictionTicker>` and `conflictsByTicker: Map<string, number>`.
- Per-ticker overlay now populates `convictionScore`, `convictionDirection`, `conflictCount`.
- Tickers present in conviction but absent from the leaderboard (e.g. sell-only names below TICKER_LIMIT
  on volume) get their own overlay entry so conviction signals aren't silently dropped.
- `CONFLICT_LIMIT = 1000` (vs App A default 100) so the full window is captured.
- Audit log now includes `convictions:` and `conflicts:` counts.
- Empty-check broadened: `leaders.length === 0 && clusters.length === 0 && convictions.length === 0`
  (a convictions-only run with no leaderboard rows is still valid data).

### `CongressAnalytics` type (`src/lib/web-sources/types.ts`)

Added three optional fields:
```typescript
convictionScore?: number | null;     // 0–100 composite; null = no real signal
convictionDirection?: "BUY" | "SELL" | null;
conflictCount?: number;              // flagged disclosures in the analytics window
```

### Yahoo adjusted-close (`src/lib/history.ts`)

- Added `adjclose?: Array<{ adjclose?: Array<number | null> }>` to `YahooChartResponse`.
- `fetchYahoo` now checks `indicators.adjclose[0].adjclose` (split+dividend-adjusted): if present and
  length-matches `timestamp`, uses it as `close`; falls back to raw `quote.close` otherwise.
- Effect on `congress-share.ts`: `ohlcBarsToCloses()` now emits adjusted prices for Yahoo-sourced symbols.
  Massive (Polygon-compatible) already requested `adjusted=true`; Tradier/Stooq remain unadjusted.

## Files changed

- `src/lib/congress-trade-client.ts` — new interfaces + functions for conviction/backtest/conflicts;
  extended `analyticsQuery` to pass chamber/party
- `src/lib/web-sources/congress-analytics.ts` — parallel-fetch conviction+conflicts; build lookup maps;
  wire into overlay; handle conviction-only tickers; broadened empty-check; richer audit log
- `src/lib/web-sources/types.ts` — `CongressAnalytics` gains convictionScore/convictionDirection/conflictCount
- `src/lib/history.ts` — `YahooChartResponse` type + `fetchYahoo` prefer adjclose

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1222/1222 (after Codex review follow-up fixes)
npm run build      # clean — all routes compiled, no type errors in generated .next/types
```

## Follow-ups / deferred items

- **Ticker-change/delisting map** (App A priority #3): old→new symbol + effective date so historical
  trades resolve to current price series. Needs a data source (FMP corporate actions or a manual KV store).
  Not implemented — requires scoping.
- **Bulk snapshot bootstrap** (`GET /api/export/bulk-snapshot`, App A priority #5): for bootstrapping or
  catching up after downtime. Not implemented — operational tooling, not a daily-flow concern.
- **Backtest in overlay**: `getAppATickerBacktest` is one-call-per-ticker; too expensive to bulk during
  refresh. Could be wired as an on-demand enrichment for the proposal/chat path, or as a background
  nightly job for the congress-traded universe.
- **Tradier/Stooq adjusted close**: Tradier returns raw close; Stooq CSV has no adjclose column. Both
  sources would require a separate split-factor lookup to produce adjusted series.

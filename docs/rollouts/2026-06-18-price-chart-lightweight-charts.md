# 2026-06-18 — Price chart in the symbol drilldown (Lightweight Charts) + keyed OHLC

## Summary
Added a daily price chart to the symbol-drilldown drawer using TradingView's open-source
**Lightweight Charts v5** (MIT), fed our own OHLC. Candlesticks + SMA50/SMA200 overlays +
volume histogram + a 1Y % change badge, themed from the app's CSS variables (follows the
dark/light terminal theme). The library is dynamically imported so it stays out of the main
bundle and loads only when the drawer opens.

To make the chart (and the technical "computed" producer) reliable, generalized the OHLC
fetch into `src/lib/history.ts` with a **keyed-first cascade: Tradier → Marketstack →
Yahoo → Stooq**. The free endpoints (Yahoo/Stooq) are blocked from datacenter IPs (verified:
Yahoo HTTP 429, Stooq serves a JS bot-challenge), so keyed providers are the reliable
primary; both Tradier and Marketstack keys in `.env.local` work and return a full year.

## Why
User chose Lightweight Charts (over scraping TradingView — rejected for ToS/fragility — or
embed widgets) for a self-contained, themable chart fed by our own data. Building it
surfaced that the free OHLC sources are unreliable server-side, so a keyed cascade was added
(in-scope: the feature is non-functional without a working source). This also hardens the
Phase-10 technical `computed` producer, which shares the same fetch.

## Files
New:
- `src/lib/history.ts` — single OHLC source. `fetchDailyOHLC` (keyed-first cascade, 30-min
  cache), `fetchTradier`/`fetchMarketstack`/`fetchYahoo`/`fetchStooq`, `parseStooqCsv`,
  `toBusinessDay`.
- `app/api/history/route.ts` — `GET /api/history?symbol=X` → chart-ready candles (full OHLC
  quad required, deduped, ascending, 'YYYY-MM-DD'). Validates symbol; 400 on bad input.
- `app/ui/price-chart.tsx` — `PriceChart` client component: lazy `import("lightweight-charts")`,
  candlesticks + SMA50/200 + volume, theme colors via `getComputedStyle`, loading/empty/error
  states, cleanup on unmount/symbol change.
- `test/history.test.ts` (7) — `toBusinessDay`, `parseStooqCsv`, `fetchDailyOHLC` (mocked
  Yahoo + cache + Stooq fallback + null).

Edited:
- `src/lib/web-sources/technical.ts` — refactored to reuse `fetchDailyOHLC` (removed its
  duplicate Yahoo/Stooq fetch); re-exports `parseStooqCsv` for back-compat.
- `app/ui/symbol-drilldown.tsx` — renders `<PriceChart>` below the header.
- `package.json` — `lightweight-charts ^5.2.0`.
- Tests `history.test.ts` / `web-sources-technical.test.ts` clear keyed env vars for
  deterministic free-path testing.

## Verification
- Initial implementation: `npx tsc --noEmit` was clean for this chart change but hit
  a concurrent `src/lib/dashboard.ts` macro-panel error; see follow-up note below.
- `npx vitest run` → **188 passed (26 files)**, including the initial history tests.
- Live: `/api/history?symbol=AAPL` → 276 real bars via Tradier (last 2026-06-18, full OHLC+vol).
- **Browser-verified**: opened the NVDA drilldown → 1Y candlestick chart with SMA50/200,
  volume, "+54.0% 1Y" badge rendered correctly, no console errors. Lightweight Charts stays
  out of the shared bundle (First Load 102 kB).
- Continuation hardening resolved the `dashboard.ts` macro-panel type/semantic issue and
  added keyed-cascade regression tests; final `tsc`/test/build results are recorded in
  `docs/rollouts/2026-06-18-keys-macro-panel-and-history-keys.md`.

## Follow-ups / risks
- **Resolved in continuation:** `src/lib/dashboard.ts` now computes macro internals only
  when the stored audit scan has full quote fields; trimmed historical shapes degrade to
  no `marketEarningsYield` instead of bad math.
- Keyed limits: Alpha Vantage (25/day) and FMP (rate-limited) keys are present but throttled;
  Tradier/Marketstack are the working sources. Cascade self-skips absent/failed sources.
- RSI/MACD sub-pane and intraday intervals are possible follow-ups; this cut is daily candles
  + SMA overlays + volume.

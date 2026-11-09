# 2026-06-19: Price Chart Timeframe Controls

## Summary
Added standard Yahoo Finance-style timeframe buttons (1D, 5D, 1M, 6M, YTD, 1Y, 5Y, All) to the Symbol Drilldown price chart, and expanded the backend OHLC history fetch from 400 days to 5 years to support the new longer timeframes.

## Why
Users requested standard timeframe choices to view both shorter and longer-term historical trends without being locked into a hardcoded 1-year view.

## Files Touched
- `app/ui/price-chart.tsx`: Added state for `activeTimeframe`, rendered the timeframe buttons in the header, and implemented `updateTimeframe` to dynamically filter the visible bars and set the chart's visible range via `timeScale().setVisibleRange()`. Also fixed a `cn` import path issue.
- `src/lib/history.ts`: Expanded the base `fetchDailyOHLC` lookup horizon from ~1.1 years (400 days) to 5 years (1825 days) and increased the Marketstack fetch limit to accommodate the larger dataset.

## Verification
- `npx tsc --noEmit` passed cleanly.
- `npm test` passed (223 tests).
- `npm run build` compiled successfully.
- Visually verified chart re-rendering and percentage change recalculation upon clicking different timeframes in the UI.

## Follow-ups
- Because the backend currently only pulls Daily OHLC data, the 1D and 5D timeframes look very sparse (showing only 1 or 5 candles). To make these views useful for day-trading analysis, we will need to integrate a dedicated intraday data provider (e.g. 1min or 5min bars) in the future.

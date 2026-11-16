# 2026-06-30 - Market Scan Source Labels

## Summary

- Latest Decisions and Market Scan source subtitles now use a shared
  `formatSourceList(...)` dashboard helper.
- `congress`, `congress.trade`, and repeated Congress.Trade source segments
  display once as `Congress.Trade`.
- `yahoo-finance-delayed-quotes` displays as `Yahoo Finance`, so the subtitle no
  longer appends `Delayed Quotes` after the main Yahoo Finance source.

## Why

Production scan provenance can contain multiple source keys that describe the
same user-facing provider. The UI previously title-cased each raw segment
independently, which made Latest Decisions read as if Congress and
Congress.Trade were separate sources and made Yahoo Finance look duplicated by a
delayed-quotes suffix.

## Files

- `app/dashboard-client.tsx`
- `src/lib/dashboard-ui.ts`
- `test/dashboard-ui.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-30-market-scan-source-labels.md`

## Verification

- `npm test -- dashboard-ui` - pass
- Post-merge `npm run lint` - pass, 0 errors / 256 existing warnings
- `npx tsc --noEmit` - pass
- `npm test` - pass, 163 files / 1569 tests
- `npm run build` - pass

## Follow-ups

- None. This intentionally leaves historical `MarketScan.source` values intact
  and normalizes only user-facing presentation.

# 2026-07-23 FMP Downgrade Mitigation UI (Antigravity)

## Summary
Added a stale-data indicator to the Console scanner UI and drilldown drawer to gracefully handle stale fundamental data after the FMP downgrade. Implemented data-hoarding scripts and shifted the provider cascade to prioritize free alternatives.

## Why
We hoarded FMP fundamentals and extended the cache TTL to 14 days, reducing API usage to stay under the free-tier limits. Because this data will slowly age, we need to show the user visually when it's out of date, preventing them from making poor trading decisions based on weeks-old numbers.

## Files Touched
- `src/lib/data-providers.ts`: Prioritized Yahoo Finance over FMP, extended FMP fundamental TTL to 14 days.
- `src/lib/fmp-gamma.ts`: Removed transcript extraction.
- `scripts/massive-hoard.ts` & `scripts/fmp-hoard.ts`: Scripts created and executed to download historical data.
- `app/console/scan/columns.tsx`: Implemented `isStaleField()` logic and rendered stale numerical fundamentals (P/E, EPS growth, Dividend Yield) with an `italic opacity-70` style, appending the stale warning to the hover tooltip.
- `app/console/ui/drilldown-data.ts`: Extended `QuoteView` to capture `fieldObservations` and implemented `isStaleViewField()`. Extended `withProvenance()` to handle stale warnings in the tooltip.
- `app/console/ui/drilldown-sections.tsx`: Implemented the fading/italicization logic across the `FundamentalsSection` to match the scan view.

## Verification
- `npm run lint`: Green
- `npx tsc --noEmit`: Clean after fixing missing types.
- `npm test`: Passed tests.
- `npm run build`: Optimized production build generated successfully.

## Follow-ups
None.

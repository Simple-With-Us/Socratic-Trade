# RapidAPI and FilingAPI / ROIC.ai Enrichment Providers Integration

## Summary
Integrated 5 new data enrichment providers into the cascading enrichment system: `FilingApiEnrichmentProvider`, `RoicEnrichmentProvider`, `FmpRapidApiEnrichmentProvider`, `InsidersRapidApiEnrichmentProvider`, and `TwelveDataRapidApiEnrichmentProvider`. All new providers are fully covered by unit tests, handle their specific quotas natively, and fail gracefully without crashing the cascade.

## Why
The user signed up for a 2-week enterprise trial of FilingAPI and a free tier of ROIC.ai. In addition, there were over 45 subscriptions available on the RapidAPI account, and the user requested that all functional ones be integrated into the enrichment cascade. We audited the available subscriptions, identifying three functional endpoints (FMP, Insiders, TwelveData) alongside the existing three, and discarded the rest which were largely returning 404s/502s.

## Files Touched
- `src/lib/data-providers.ts` - Implemented 5 new provider classes (`FilingApiEnrichmentProvider`, `RoicEnrichmentProvider`, `FmpRapidApiEnrichmentProvider`, `InsidersRapidApiEnrichmentProvider`, `TwelveDataRapidApiEnrichmentProvider`) and added them to `getEnrichmentProvider()` so they run automatically in the cascade. Added `quotaScarce` sorting so that non-scarce providers run first, minimizing consumption of scarce quotas.
- `src/lib/rapidapi-quota.ts` - Added the three new RapidAPI provider keys to `RapidApiProviderKey` to ensure they abide by the global `rapidApiCombinedDailyCap()` ceiling of 900 calls/day. 
- `test/rapidapi-providers.test.ts` - Added full test coverage for all new providers, and verified that the combined quota tracks consumption appropriately across all registered RapidAPI providers.

## Verification
- Verified `npm test -- test/rapidapi-providers.test.ts` passes, confirming all JSON path extractions, mock behaviors, and quota boundaries perform as expected.
- Verified build and lint checks pass via `npm run lint && npx tsc --noEmit && npm run build`.

## Follow-ups
None for this specific task.

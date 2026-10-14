# Keyless options enrichment (Cboe / Alpaca / Tradier)

## Context & Objective

`nearTheMoneyIv` and `putCallRatio` were only filled by opt-in Robinhood MCP enrichment, so shared and background market scans left those cells empty.  Wire keyless Cboe delayed options JSON as the primary source, Alpaca indicative snapshots and Tradier chains as fallbacks, using the same `deriveOptionMetrics` math as `robinhood-options.ts`.

## Changes Made

- Added `src/lib/keyless-options-enrichment.ts` with `CboeOptionsEnrichmentProvider`, `AlpacaOptionsEnrichmentProvider`, and `TradierOptionsEnrichmentProvider` (per-symbol cache, paced sequential fetches).
- Registered providers in `getEnrichmentProvider()` when `KEYLESS_OPTIONS_ENRICHMENT_ENABLED` is on (default ON).
- Updated `src/lib/source-capability-matrix.ts`, `src/lib/enrichment-coverage.ts` (`COVERAGE_OPTIONS_METRICS_FIELDS`), and `src/lib/data-catalog.ts`.
- Tests: `test/keyless-options-enrichment.test.ts`, `test/source-capability-matrix.test.ts`.

## Decisions & Trade-offs

- Three cascade providers (not one internal fallback) so per-field `sources` attribution matches the capability matrix.
- Alpaca/Tradier lanes register only when market-data / Tradier credentials resolve (same pattern as snapshot + history tiers).
- Cboe fetch uses `fetch` with redirect follow (CDN → `cdn-api.cboe.com`); Alpaca/Tradier use `politeFetch` to avoid a `data-providers` import cycle.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/keyless-options-enrichment.test.ts test/source-capability-matrix.test.ts
npm run build
```

All passed in the cloud VM (2026-10-14).

## Next Steps & Blockers

- None for merge; production will pick up on deploy after `main` merge (docs-only paths excluded from Coolify `watch_paths` — runtime files are in the diff).

## Zero-Code Findings

- Live Cboe options JSON for `AAPL` includes `data.current_price` and per-contract `iv` / `open_interest` / OCC `option` symbols; many deep ITM rows carry `iv: 0`, so ATM filtering in `deriveOptionMetrics` remains important.

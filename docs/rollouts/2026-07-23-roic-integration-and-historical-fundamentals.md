# Rollout: ROIC.ai Integration and Historical Fundamentals Storage (2026-07-23)

## Context & Objective
- **Historical Fundamentals Storage**: Implemented schema v56 `historical_fundamentals` table and `db-fundamentals.ts` to log time-series fundamental observations across scans with full ISO timestamp precision (`asOf`).
- **ROIC.ai Provider Integration**: Added `RoicAiEnrichmentProvider` to `src/lib/data-providers.ts` to serve as a high-fidelity fundamental provider for financial statements, 90+ ratios, and quarterly earnings call transcripts.
- **Massive 5-Year Data Hoarding**: Fixed rate-limit pacing logic in `scripts/massive-hoard.ts` and triggered background download for ~1,305 trading days of daily market breadth and OHLCV flat files.

## Changes Made
- `src/lib/db.ts`: Added version 56 migration for `historical_fundamentals`.
- `src/lib/db-fundamentals.ts`: CRUD functions for fundamental history logging.
- `src/lib/data-providers.ts`: Integrated `RoicAiEnrichmentProvider` and timestamp logging into `CascadingEnrichmentProvider`.
- `src/lib/evidence-facts.ts`: Prioritized exact timestamp recency in field observation arbitration.
- `scripts/fmp-hoard.ts`: Updated secrets path to `global-api-keys.env`.
- `scripts/massive-hoard.ts`: Fixed key loading and rate limit retries.
- `test/persistence-hardening.test.ts`: Updated schema version assertions.
- `test/connection-health-routing.test.ts`: Updated API key test injection.

## Verification State
- `npx tsc --noEmit`: Clean (0 errors).
- `npm test`: All tests passing.

## Next Steps
- Monitor background Massive hoarding completion.

# 2026-07-24 Data Sources User Keys Migration & UI Connection Fields

## Context & Objective
Per owner directive, candidate data sources Tiingo (`tiingo`), Twelve Data (`twelvedata`), Fintech Studios (`fintechstudios`), and Apify (`apify`) have been configured as per-user-only credentials, added to the UI API Keys catalog, copied into `LOCAL_USER`'s encrypted SQLite key store on boot migration, and purged from `process.env`.

## Changes Made
- `src/lib/db-api-keys.ts`:
  - Classified `tiingo`, `twelvedata`, `fintechstudios`, and `apify` as `per-user-only` credentials in `credTierForService`.
  - Added `ALL_SERVICE_ENV_VARS` mapping to support alternate env var names (`TWELVE_DATA_API_KEY`, `APIFY_API_KEY`, `FINTECH_STUDIOS_API_KEY`, `POWERINTELL_API_KEY`, etc.) during migration and process purging.
  - Updated `purgeProcessEnvUserKeys()`, `migrateLocalEnvCredentials()`, `upsertUserApiKey()`, and `deleteUserApiKey()` to delete all matching env var names from `process.env`.
- `app/api/keys/route.ts`:
  - Added catalog definitions for `tiingo`, `twelvedata`, `fintechstudios`, and `apify` to `API_KEY_CATALOG` so they are exposed in the Settings API Keys user interface.
- `test/api-keys-env-purge.test.ts`:
  - Added unit test verifying that `tiingo`, `twelvedata`, `fintechstudios`, and `apify` env keys are migrated to `LOCAL_USER`'s encrypted store, deleted from `process.env`, and fail closed for non-local tenants without stored keys.

## Verification State
- `npx vitest run test/api-keys-env-purge.test.ts`: 4/4 tests passed.
- `npx vitest run test/key-resolution-tiering.test.ts`: 28/28 tests passed.

## Next Steps
Execute `scripts/land.sh` to push, create PR, and auto-deploy to production.

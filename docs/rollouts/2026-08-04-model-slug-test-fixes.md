# 2026-08-04: Model Slug Migration & Test Fixes

## Context & Objective
The user requested final verification of the model slug migration, ensuring the codebase consistently uses the new Provider Native Slugs (e.g., `gpt-5.6-sol`, `gpt-4o`) and that test regressions are resolved. The persistence of legacy `-latest` slugs was causing frustration.

## Changes Made
- Performed a mass replacement of legacy model slugs across `src/`, `app/`, and `test/` directories.
- Cleaned up duplicate object properties generated during the refactor in `app/console/lib/models.ts`, `src/lib/llm-usage.ts`, and `src/lib/usage-budget.ts`.
- Fixed the `isGpt56Model` regex in `src/lib/llm-request.ts` to properly match the new `gpt-5.4` and `gpt-5.6` slugs without the `-latest` suffix.
- Fixed test regressions in `test/history.test.ts` and `test/robinhood-tenant-isolation.test.ts`. These failures were caused by a recent change that persisted EOD bars to the local SQLite DB (`imported_price_eod` table). Since the tests share a `historyTestDb` per file, data from one test was bleeding into subsequent tests that expected a cache miss. Added `getDb().exec("DELETE FROM imported_price_eod")` to the `beforeEach` block to ensure DB isolation between tests.
- Fixed test regressions in `test/usage-budget.test.ts` and `test/usage-budget-strategy-integration.test.ts` to reflect correct downgraded model identifiers (`gpt-5.4-mini`).

## Verification State
- `npm test test/history.test.ts test/tradier.test.ts test/robinhood-tenant-isolation.test.ts` completed successfully with 89/89 tests passing.
- `bash scripts/land.sh` ran successfully and passed the tsc, lint, and build verification gates.

## Next Steps & Blockers
- None. The migration is complete and the PR has been created via `land.sh`.

## Follow-up Fixes
- Corrected the `isGpt56Model` regex which erroneously included `gpt-5.4-mini` and `gpt-5.4-nano`, causing reasoning effort test regressions (expected low/medium/high, received none-to-max ladder).
- Restored the EXACT display slugs requested by the user, removing `-latest` prefixes completely from display names for GPT, Anthropic, Mistral, and DeepSeek models, matching the exact user specifications (e.g. `Gemini 3.5 Flash Lite`).
- Tests `chat-llm.test.ts`, `llm-request.test.ts` and `strategy-reasoning-control.test.ts` now pass under Node 24.

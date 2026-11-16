# 2026-07-24 Purge LLM and User Interface Keys from process.env

## Context & Objective
Per owner directive, all LLM API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`) and user-providable interface credentials (such as Alpaca, Pinecone, Voyage, SiliconFlow, Apify, Tiingo, TwelveData, Logo.dev) are purged from `process.env` so `process.env` never retains ambient LLM or user keys in memory at runtime.

## Changes Made
- `src/lib/db-api-keys.ts`:
  - Expanded `LOCAL_ENV_MIGRATION_SERVICES` to cover all LLM and user-providable interface credentials.
  - Added `purgeProcessEnvUserKeys()` helper that deletes matching `process.env[envVar]` properties.
  - Updated `migrateLocalEnvCredentials()` to purge `process.env` immediately after one-time migration into SQLite for `local`.
  - Updated `upsertUserApiKey()` and `deleteUserApiKey()` to delete matching `process.env[envVar]` properties whenever a user key is added, updated, or removed.
- `test/api-keys-env-purge.test.ts`: Added unit tests verifying `process.env` purging on boot migration, key upsert, and key deletion.

## Verification State
- `npx eslint . --quiet`: Passed.
- `npx tsc --noEmit`: Passed with zero type errors.
- `npx vitest run test/api-keys-env-purge.test.ts`: 3/3 tests passed.

## Next Steps
Land via `scripts/land.sh` and auto-deploy to production.

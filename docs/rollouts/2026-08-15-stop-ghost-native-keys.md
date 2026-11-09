# Stop boot-reseeding Gemini / DeepSeek keys onto Connections

## Context & Objective

The owner kept seeing Gemini and DeepSeek keys reappear on the primary Connections account after removing them.  This note records why, whether the recent failed Gemini/DeepSeek calls were OpenRouter or native, and the boot-path fix.

## Changes Made

- `migrateLocalEnvCredentials` no longer treats a delete tombstone (`__DISABLED__`) as an empty row.  Coolify re-injects Infisical env on every deploy; a tombstone is now left alone.
- Gemini and DeepSeek are no longer auto-copied from `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` onto `user_api_keys`.  Those Infisical values are still purged from `process.env` after boot so they cannot silently serve after a delete.
- Existing primary-account rows whose label is exactly `migrated from env` for Gemini/DeepSeek are tombstoned on the next boot.  A user-pasted native key (any other label) is left alone.
- Tombstone tests now re-inject env after delete, matching a real Coolify restart.  The old test was a false pass because `deleteUserApiKey` also wiped `process.env`.

Touched:

- `src/lib/db-api-keys.ts`
- `test/api-keys-tombstone.test.ts`
- `test/api-keys-env-purge.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-15-stop-ghost-native-keys.md`

## Decisions & Trade-offs

- Owner follow-up the same day: delete the Infisical source.  `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` removed from ST Infisical `prod` `/` (shared type).  Verified gone via names-only listing.  Left `GEMINI_RPM_LIMIT` / project metadata and `OPENROUTER_ADMIN_KEY` (agent admin, not app chat).  Shared project had no LLM runtime names.  `infisical-secrets-safe.sh set` now refuses those names so the next agent cannot write them back.
- Chat (`llmForModel`) still goes native if a user later pastes a Gemini/DeepSeek key.  Strategy/Red Team still prefer OpenRouter first via `resolveLlmEndpoint`.
- Did not stop migrating other LLM env keys (OpenAI / Anthropic / xAI / OpenRouter).  Only Gemini and DeepSeek were present in Infisical and were the keys the owner saw come back.

## Verification State

- Production `user_api_keys` (2026-08-15, metadata only): `gemini` and `deepseek` on `local`, label `migrated from env`, created 2026-07-24.  OpenRouter key present (2026-07-16).
- Infisical ST prod `/`: `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` present.  `OPENROUTER_API_KEY` is not in Infisical (the OpenRouter row is a user paste).
- Last-48h `llm_usage`: every Gemini/DeepSeek-named model row is `provider=openrouter` (e.g. `google/gemini-3.7-flash` red-team, `google/gemini-3.1-pro-preview` strategy).  No native `gemini` / `deepseek` provider rows.
- Tests: `npx vitest run test/api-keys-tombstone.test.ts test/api-keys-env-purge.test.ts` (plus full gate in `land.sh`).

## Next Steps & Blockers

- After this merges, the next prod boot tombstones the two env-seeded rows.  Connections should stop showing Gemini/DeepSeek unless the owner pastes them.
- Infisical ST prod `/` no longer has LLM runtime API keys.  Next Coolify boot will not re-inject Gemini/DeepSeek.  Combined with the tombstone/no-seed code, Connections should stay clean.
- Red Team 45s hard abort (the actual failure mode of those OpenRouter calls) is still open.

## Zero-Code Findings

Failed 48h Gemini/DeepSeek Red Team and strategy calls went through **OpenRouter**, not the native Google/DeepSeek APIs.  The ghost keys on Connections were a separate boot-migration bug, not the transport for those failures.

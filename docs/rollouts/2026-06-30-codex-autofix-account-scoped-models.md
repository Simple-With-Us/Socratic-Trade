# 2026-06-30 — PR #267 codex-autofix: account-scoped strategy-model migration

## Summary
Responded to the two open P2 review threads left by `chatgpt-codex-connector`
on PR #267 ("Fix settings scope and help UX"). Added a one-time versioned DB
migration (v7) that safely backfills the now-account-scoped LLM model fields
into existing `account_strategy_state` rows, plus a focused regression test.

## Why
PR #267 moved `llmModel`, `redTeamLlmModel`, and `llmReasoningEffort` out of
`USER_LEVEL_POLICY_FIELDS` so Strategy Studio model selection is per connected
account. For existing data it relied on `withLegacyStrategyModelSeed`, a
**transient** read-time overlay sourced from `user_settings.policy`. Codex
flagged two real back-compat hazards with that approach:

1. **Persist legacy model seeds before clearing user policy** (`db-profiles.ts:93`).
   With multiple legacy `account_strategy_state` rows that lack the model fields,
   the seed is never persisted. The first per-account `setPolicy` calls
   `writeUserPolicyFields`, which rewrites `user_settings.policy` with only the
   user-level fields — dropping the model fields. Any other account not yet saved
   then loses its seed source and falls back to defaults.

2. **Stop stale account rows from overriding cleared models** (`db-profiles.ts:281`).
   Before this PR, lazily-seeded account rows were written with the *full* base
   policy (including the then-current user model). Now that the model fields are
   no longer stripped on read, such a row's stale `redTeamLlmModel` /
   `llmReasoningEffort` is treated as authoritative account scope and can
   resurrect a model the user has since cleared globally.

Both are migration concerns with the same root cause (no one-time migration; a
transient seed). Because these fields were strictly user-level before the PR —
exactly one value per user — there is no per-account intent to preserve, so the
correct migration is unambiguous: every account inherits the single legacy value.

## What changed
- `src/lib/db.ts`
  - New versioned migration `version: 7` (`account_scoped_strategy_models_backfill`)
    in `MIGRATIONS`.
  - Extracted the body into exported `backfillAccountScopedStrategyModels(db)`
    (mirrors the existing exported `migrateGlobalPolicyToLocalUser` /
    `applySp500DefaultUniverseMigration` pattern) so it is unit-testable.
  - Behavior, per user with a `user_settings.policy` row:
    - For each of the three model fields **present** in `user_settings.policy`,
      set it on every `account_strategy_state` row (overwriting stale copies).
    - For each field **absent** (user had no override → effective value was the
      compiled default), delete any stale copy from the rows so `mergePolicy`
      falls back to that same default.
    - Strip the three fields from `user_settings.policy` so the runtime seed
      (`readLegacyStrategyModelFields`) becomes a permanent no-op.
  - The versioned-migration guard (`PRAGMA user_version`) runs it exactly once.
- `test/account-scoped-models-migration.test.ts` (new)
  - Builds a minimal legacy DB and asserts: legacy value seeds into all rows +
    strips from user_settings (finding #1); stale row model overwritten by the
    current user value and a globally-cleared field dropped (finding #2); no-op
    when the user never set model overrides.

The runtime `withLegacyStrategyModelSeed` overlay from the PR is left in place as
harmless defensive code — after migration `user_settings.policy` carries no model
fields, so it returns `{}`.

## Files
- `src/lib/db.ts`
- `test/account-scoped-models-migration.test.ts`
- `STATUS.md`
- `docs/rollouts/2026-06-30-codex-autofix-account-scoped-models.md` (this note)

## Verification
- `npx tsc --noEmit` — type-clean for this change. (All residual errors are
  confined to `congress-*` files and are artifacts of an ambient stub used to
  resolve the inaccessible private dep — see Environment limitation below.)
- `npx vitest run test/account-scoped-models-migration.test.ts test/per-account-policy-isolation.test.ts`
  — 13 tests pass (3 new migration cases + existing per-account isolation suite).

### Environment limitation
The autofix runner's GitHub token cannot read the private git dependency
`@jaywedgeworth22/congress-trading-shared` (`gh api` → 404), so a full
`npm install` aborts and `npm test` / `npm run build` cannot run end-to-end here.
To verify, the dep was temporarily stripped from the manifests to install the
rest, then `package.json` / `package-lock.json` were restored to match
`origin/main` (confirmed: no diff). The required `verify` CI gate has repo
access and runs the authoritative `tsc → test → build` trio on push.

## Follow-ups
- None for the findings. The two Codex threads are resolved in code; both review
  threads marked resolved.
- If desired, a future cleanup could drop `withLegacyStrategyModelSeed` entirely
  once all production DBs have applied migration v7, but it is harmless to keep.

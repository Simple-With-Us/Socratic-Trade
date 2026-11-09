# Rollout: Per-user policy scoping (Phase 11 M3)

**Date:** 2026-06-21
**Branch:** feat/per-user-policy-scoping
**Effort:** S — additive cleanup + one new route + one new test file

---

## Summary

Closed the last three legacy gaps that remained after the per-user policy
refactor. The functional path (getPolicy/setPolicy/getStrategyPrompt/
setStrategyPrompt/all profile CRUD) was already per-user; what remained were
dead global-settings seeds in migrate(), one live global-settings read in
ensureDefaultProfile(), one dead global-settings update in the S&P 500 universe
migration, and a missing delete route + isolation test.

---

## What changed

### 1. Removed global settings seeds (db.ts migrate())
The two `INSERT OR IGNORE INTO settings` calls that seeded `'policy'` and
`'strategyPrompt'` as global rows were removed. These rows were never read at
runtime (all reads go through `user_settings` and `strategy_profiles` by userId),
but their presence was a maintenance hazard and could have confused a future
contributor into reading them directly.

### 2. One-time migration: copy global rows to 'local' user
Added `migrateGlobalPolicyToLocalUser()` — guarded by migration key
`migration:global_policy_to_local_user:2026-06-21` — that copies any existing
global `settings.policy` / `settings.strategyPrompt` rows into `user_settings`
for the `'local'` user. This fires at most once per database; existing
single-user DBs lose nothing. After it fires, the global rows become dead
weight (never read, not deleted, harmless).

### 3. Fixed ensureDefaultProfile to use constants, not global settings table
`ensureDefaultProfile` used to read from `settings WHERE key='policy'` and
`settings WHERE key='strategyPrompt'` to seed the initial profile row.
It now reads from `user_settings` (which migrateGlobalPolicyToLocalUser may have
just populated) and falls back to the compiled-in `DEFAULT_POLICY` /
`DEFAULT_STRATEGY_PROMPT` constants. The global settings table is no longer
read at runtime.

### 4. Simplified applySp500DefaultUniverseMigration
Removed the block that read and updated `settings WHERE key='policy'` (the global
row). The local user's canonical policy is now exclusively in `user_settings` and
`strategy_profiles`; both are still updated by the S&P 500 migration.

### 5. Added deleteStrategyProfile (db.ts)
New export: `deleteStrategyProfile(id, userId)`.
- Throws "Strategy profile not found." if the profile doesn't exist or belongs to
  a different user (ownership-scoped 404 semantics).
- If the deleted profile was active, reassigns the active flag to the OLDEST
  remaining profile (by created_at ASC). If no profiles remain, none is active.
- Emits an audit event with `action: "delete"`, the profile name, and `wasActive`.

Decision (from owner): reassign-to-oldest (smooth UX) rather than return 400.

### 6. Added DELETE /api/profiles/[id] route
Added a `DELETE` handler to `app/api/profiles/[id]/route.ts` that:
- Resolves userId via `resolveRequestUserId(request)`.
- Calls `deleteStrategyProfile(id, userId)`.
- Returns 204 on success, 404 if not found / wrong user, 400 on other errors.

### 7. Added two-user isolation test
`test/per-user-policy-isolation.test.ts` — 6 tests covering:
- Independent policy values per user
- Independent strategy prompts per user
- Profile list isolation (user A's profiles not visible to user B)
- deleteStrategyProfile reassigns active to oldest remaining
- deleteStrategyProfile throws for cross-user access attempt
- deleteStrategyProfile with sole profile leaves zero profiles

---

## Why

M3 was marked `[todo]` in `docs/phase-11-multi-user.md` even though the
functional per-user path was already complete. The remaining three artifacts in
db.ts were maintenance hazards (dead reads, misleading seeds). The delete route
closed a lifecycle gap — users need to be able to delete profiles they create.
The isolation test provides a regression harness that proves the per-user
invariant holds end-to-end.

---

## Files touched

- `src/lib/db.ts` — migrate(), new migrateGlobalPolicyToLocalUser(), ensureDefaultProfile() rewrite, applySp500DefaultUniverseMigration() simplification, new deleteStrategyProfile()
- `app/api/profiles/[id]/route.ts` — added DELETE handler, added deleteStrategyProfile import
- `test/per-user-policy-isolation.test.ts` — new file, 6 tests
- `docs/phase-11-multi-user.md` — M3 updated from `[todo]` to `[done]` with implementation summary
- `PLAN.md` — Phase 11 row updated to note M3 complete
- `docs/rollouts/2026-06-21-per-user-policy-scoping.md` — this file

---

## Verification

```
cd /Users/jay/apps/wt-policy

npx tsc --noEmit
# exit 0 — clean

npm test
# 72 test files passed (599 tests) — up from 71/593 before this commit
# policy-default-universe.test.ts: 2/2 still passing (legacy DB compat)
# per-user-policy-isolation.test.ts: 6/6 new tests passing
```

---

## Follow-ups / deferred

- The global `settings` table rows for `policy` and `strategyPrompt` remain as
  dead rows in every existing DB. They do not need to be deleted (harmless),
  but a future cleanup migration could remove them. Low priority.
- `getSetting`/`setSetting` remain public exports (they back system keys:
  run locks, migration watermarks). A JSDoc comment warning against using them
  for user-facing policy could be added; the design doc noted this as optional.
  Not done in this commit — low risk.
- M4 (fills/proposals/snapshots data isolation audit) and bounded concurrent
  scheduling remain as the next Phase 11 items.

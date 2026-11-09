# Scope: Per-user policy/profiles/prompt/tuning scoping (Phase 11 M3)

_Scoped 2026-06-21 (multi-agent design pass). Effort: **s** · Autonomy: **autonomous-after-decisions**_

## Current state
LARGELY ALREADY DONE — the functional per-user path is complete; only three legacy artifacts remain in db.ts.

**What is fully per-user today:**
- `getPolicy(userId)` (db.ts:677): reads from `getActiveStrategyProfile(userId)` first, then `getUserSetting(userId, "policy", DEFAULT_POLICY)` — both scoped to `user_settings` and `strategy_profiles` by userId.
- `setPolicy(policy, userId)` (db.ts:699): writes `setUserSetting(userId, "policy", merged)` and `syncActiveProfile(...)` — per-user.
- `getStrategyPrompt(userId)` (db.ts:705): reads active profile prompt, then `getUserSetting(userId, "strategyPrompt", DEFAULT_STRATEGY_PROMPT)` — per-user.
- `setStrategyPrompt(prompt, userId)` (db.ts:709): writes `setUserSetting(userId, ...)` and `syncActiveProfile` — per-user.
- All profile CRUD (`createStrategyProfile`, `updateStrategyProfile`, `activateStrategyProfile`, `getStrategyProfile`, `listStrategyProfiles`) (db.ts:952-1028): already require `userId` and filter by `user_id = ?`.
- `TuningSettings` is embedded in `TradingPolicy.tuning`, so it is already per-user when the policy is per-user.
- `reflection_summary` is stored via `setUserSetting(userId, "reflection_summary", ...)` (post-mortem.ts:151) and read via `getUserSetting(input.userId, ...)` (strategy.ts:926) — per-user.
- All API routes already call `resolveRequestUserId(request)` and pass userId downstream: policy/route.ts:13, profiles/route.ts:8, profiles/[id]/route.ts:9, profiles/[id]/activate/route.ts:10, strategy/tune/route.ts:9, strategy/enable/route.ts:9, strategy/pause/route.ts:8.
- All lib callers already accept userId: strategy.ts:90, strategy-tuning.ts:122, red-team.ts:24, post-mortem.ts:59, scheduler.ts:47/118, triggers.ts:114/151, alerts.ts:68, notifications.ts:15, dashboard.ts:37/151, fills.ts:17, performance.ts:783, chat/orchestrator.ts:94/125/134/149.
- Auth trust is live: middleware.ts enforces Auth.js Google session verification and strips spoofable headers; request-user.ts maps verified email to userId via identity.ts.

**Three legacy artifacts in db.ts that are the actual remaining gap:**

1. db.ts:392-393 (`migrate()`) — seeds global `settings` table rows `'policy'` and `'strategyPrompt'` for the `local` user. These bootstrap rows are never read at runtime (getPolicy/getStrategyPrompt read from user_settings/strategy_profiles), but they exist in every fresh DB.

2. db.ts:402-403 (`ensureDefaultProfile()`) — reads from global `settings WHERE key = 'policy'` and `'strategyPrompt'` to seed the initial `strategy_profiles` row for the `'local'` user. This is the one runtime consumer of the global rows — but only fires once on a fresh or legacy DB.

3. db.ts:437-441 (`applySp500DefaultUniverseMigration()`) — reads and updates `settings WHERE key = 'policy'` for the global fallback row, then separately updates `user_settings WHERE key = 'policy'` and `strategy_profiles WHERE id = 'default'`. This two-path migration logic is a maintenance hazard.

**What does NOT exist yet:**
- No delete route for `strategy_profiles` (no `DELETE /api/profiles/[id]`).
- The phase-11 doc (docs/phase-11-multi-user.md:113) still marks M3 as `[todo]` — inaccurate given the above analysis.
- The global `settings` table bootstrap rows for `policy` and `strategyPrompt` are dead weight that could confuse a future contributor into reading them directly.
- No test coverage specifically verifying that a second non-local user gets isolated policy/profile/prompt from `local`.

## Recommended approach
The real work is small: three cleanup tasks in db.ts, two doc updates, and one test addition. The global `settings` rows for `policy` and `strategyPrompt` need to be removed from the migrate() seed (db.ts:392-393), and `ensureDefaultProfile` needs to be rewritten to seed from `DEFAULT_POLICY`/`DEFAULT_STRATEGY_PROMPT` constants instead of reading from the global settings table (db.ts:402-403). The `applySp500DefaultUniverseMigration` can be simplified to only update `user_settings` and `strategy_profiles` rows, dropping the global `settings.policy` read-update path (db.ts:437-441). A delete-profile route (`DELETE /api/profiles/[id]`) should be added since profiles are now genuinely per-user and users need lifecycle control. A two-user isolation test should be added to verify that two distinct userIds get independent policy/profile/prompt values. Finally, phase-11 docs and STATUS.md should be updated to reflect M3 as done.

## Phased plan
1. **Remove global settings seeds and fix ensureDefaultProfile** (xs) — In db.ts:392-393, remove the two `ensure.run('policy', ...)` and `ensure.run('strategyPrompt', ...)` INSERT OR IGNORE calls from `migrate()` — they seed the global `settings` table which is never read at runtime. In `ensureDefaultProfile` (db.ts:398-418), replace the reads from `settings WHERE key = 'policy'` and `settings WHERE key = 'strategyPrompt'` (db.ts:402-403) with direct references to the `DEFAULT_POLICY` and `DEFAULT_STRATEGY_PROMPT` constants — this eliminates the last runtime consumer of the global policy/prompt rows. The behavior for fresh and legacy databases is unchanged (the INSERT OR IGNORE means the seed was idempotent anyway), but the global read path is gone. Run `npx tsc --noEmit` and `npm test` to confirm no regressions.  
   _Files:_ src/lib/db.ts (lines 391-418)
2. **Simplify applySp500DefaultUniverseMigration to drop global settings path** (xs) — In `applySp500DefaultUniverseMigration` (db.ts:421-468), remove the block that reads `settings WHERE key = 'policy'` (db.ts:437) and updates it (db.ts:441). The `local` user's canonical policy is in `user_settings` (already covered by the block at db.ts:445-451) and in `strategy_profiles` (already covered by db.ts:454-463). The global `settings` row is now a dead store; migrating it is wasted work and a source of future confusion. After this change, the global `settings` table only holds the migration watermark key, the `strategy_run_lock:userId` key, and any internal settings — never policy or prompt. Run `npm test` including `policy-default-universe.test.ts`.  
   _Files:_ src/lib/db.ts (lines 437-443)
3. **Add DELETE /api/profiles/[id] route** (s) — Add a `deleteStrategyProfile(id, userId)` function to db.ts that (a) refuses to delete if `active = 1` (the active profile must stay or be replaced), (b) refuses to delete if it is the only profile for the user (a user must always have at least one profile), and (c) does `DELETE FROM strategy_profiles WHERE id = ? AND user_id = ?`. Add the corresponding `DELETE` handler to `app/api/profiles/[id]/route.ts` that calls `resolveRequestUserId(request)` then `deleteStrategyProfile(id, userId)`. This closes the lifecycle gap for per-user profiles.  
   _Files:_ src/lib/db.ts (new deleteStrategyProfile function), app/api/profiles/[id]/route.ts (new DELETE handler)
4. **Add two-user isolation test** (s) — Add a new vitest test (e.g. `test/per-user-policy-isolation.test.ts`) that: (1) creates two userIds ('user-a' and 'user-b'), (2) sets distinct policies (different maxOrderNotional, different strategy prompt) for each, (3) creates a named profile for user-a but not user-b, (4) asserts getPolicy('user-a') returns user-a's values, getPolicy('user-b') returns user-b's values, and they are not equal, (5) asserts listStrategyProfiles('user-a') does not include user-b's profiles and vice-versa, (6) asserts getStrategyPrompt('user-a') !== getStrategyPrompt('user-b'). Use a temp DATABASE_URL per the beforeAll pattern in existing tests.  
   _Files:_ test/per-user-policy-isolation.test.ts (new file)
5. **Update docs to reflect M3 complete** (xs) — Update `docs/phase-11-multi-user.md` line 112 to change `M3 [todo]` to `M3 [done]` and add a current-implementation paragraph matching the pattern of M1/M2/M5. Update `PLAN.md` line 22 (Phase 11 entry) to note M3 as complete. Update `STATUS.md` to reflect the M3 gap is closed. Create a rollout note at `docs/rollouts/YYYY-MM-DD-m3-per-user-policy.md` documenting what changed, what was already done, verification commands, and the residual global-settings cleanup.  
   _Files:_ docs/phase-11-multi-user.md, PLAN.md, STATUS.md, docs/rollouts/2026-06-21-m3-per-user-policy.md

## Owner decisions needed
- Should deleteStrategyProfile silently reassign the active flag to the oldest remaining profile, or return a 400 requiring the caller to activate another profile first? (The second is safer; the first is smoother UX.)
- After removing the global `settings` seed rows for 'policy' and 'strategyPrompt', existing databases that only have these global rows (no user_settings row, no strategy_profiles row — a fresh install that somehow never got the ensureDefaultProfile path) would start with DEFAULT_POLICY rather than whatever was in global settings. This is the correct behavior, but confirm no production or dev DB is in that state before deploying.
- Should the `getSetting`/`setSetting` functions (db.ts:532-548) remain public exports? They are used for internal/system keys (run locks, migration watermarks) but could be misused by future contributors to set policy globally. Consider adding a JSDoc warning or renaming to `getSystemSetting`/`setSystemSetting` to signal their limited scope.

## Risks
- The `policy-default-universe.test.ts` seeds a legacy-style DB with a global `settings.policy` row and no `user_settings` row. After Phase 1 (removing the global read from ensureDefaultProfile), this test's seed needs to also insert a `user_settings` row, or the test will find getPolicy() returning DEFAULT_POLICY instead of the seeded legacy value. The test must be updated in the same commit as the db.ts change or it will fail.
- If any deployed DB exists with a `local` user that only has a global `settings.policy` row and no corresponding `user_settings` row or `strategy_profiles` row (possible if the app was first run on a version before strategy_profiles existed), removing the global read would cause that user to lose their policy on next startup. The migration guard in ensureDefaultProfile (checking COUNT in strategy_profiles) protects against the profiles case, but not the user_settings fallback case. Verify production DB state before shipping Phase 1.
- The global `settings` table rows for `policy` and `strategyPrompt` exist in every existing database. After Phase 1, they become dead rows. They do not need to be deleted (there is no harm in their presence), but a future contributor could read them directly and be confused. Low risk but worth noting in the rollout doc.

## Dependencies
Auth trust (middleware.ts + identity.ts) is already shipped and is the prerequisite for multi-user correctness — it is done. No other work needs to land first. Phases 1-5 above are independent of each other and can land in a single commit.

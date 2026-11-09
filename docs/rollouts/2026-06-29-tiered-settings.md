# Tiered Settings — 2026-06-29

## Summary
Implemented three-phase settings architecture improvement: per-user auto-resume-on-boot toggle, UI split into User/Account tiers, and persistence write-path refactor that writes user-level fields to `user_settings` and account-level fields to `account_strategy_state`.

## Why
The settings had two tiers but the code treated everything as one monolithic blob:
1. On server restart, all accounts stopped — only a blunt `AUTONOMY_RESUME_ON_BOOT=1` env var controlled this
2. Settings UI showed 8 tabs with zero visual distinction between user and account scope
3. Persistence wrote everything as user-scoped via `setPolicy` to `user_settings`, then mirrored into `account_strategy_state` — no true per-account settings isolation

## Phase 1: Auto-restart toggle
- Added `autoResumeOnBoot` user-level setting stored in `user_settings` (key `auto_resume_on_boot`)
- Added `getAutoResumeOnBoot()` / `setAutoResumeOnBoot()` in `src/lib/db-settings.ts`
- Modified `reconcileAutonomyOnBoot()` in `src/lib/scheduler.ts` to check per-user setting; the env var `AUTONOMY_RESUME_ON_BOOT=1` remains as a global override
- Added API endpoint `POST/GET /api/settings/auto-resume`
- Added UI toggle in Settings (moved to User tier in Phase 2)
- Added `autoResumeOnBoot` to `DashboardSnapshot` type

## Phase 2: Settings UI split
- Added top-level `Segmented` control for "User Settings" / "Account Settings" in `SettingsContent`
- User tier: Connections, Display, Notifications, Data tabs + auto-resume toggle
- Account tier: Strategy, Operate, Safety, Tax, Tuning tabs + account picker dropdown
- Account picker calls `POST /api/connected-accounts/:id/activate` to switch accounts
- Added tier-based JSX wrapper fragments (`{settingsTier === "account" && <>...}`) to each section

## Phase 3: Persistence write-path refactor
- Defined `USER_LEVEL_POLICY_FIELDS` set in `src/lib/db-profiles.ts`: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`
- Added helper functions: `pickUserFields()`, `pickAccountFields()`, `readUserPolicyFields()`, `writeUserPolicyFields()`
- Modified `setPolicy()`:
  - With connected account: writes user fields to `user_settings.policy`, account fields to `account_strategy_state.policy` + `strategy_profiles`
  - Without connected account (legacy): writes full policy to `user_settings.policy` (backward compatible)
- Modified `getPolicy()`: overlays user fields from `user_settings.policy` on top of account fields from `account_strategy_state`

## Files touched
- `src/lib/db-settings.ts` — added auto-resume functions
- `src/lib/scheduler.ts` — modified `reconcileAutonomyOnBoot()`, added import
- `src/lib/db-profiles.ts` — tier split helpers, modified `setPolicy()` and `getPolicy()`
- `src/lib/dashboard.ts` — added `getAutoResumeOnBoot` import, added to snapshot
- `app/dashboard-types.ts` — added `autoResumeOnBoot` field
- `app/dashboard-client.tsx` — tiered settings UI, account picker, auto-resume toggle
- `app/api/settings/auto-resume/route.ts` — new GET/POST endpoint

## Verification
- `npx tsc --noEmit` — 0 app-level errors (only pre-existing .next types issues)
- `npm run lint` (changed files only) — 0 errors, 35 warnings (pre-existing)
- `npm test` — 158 files, 1533 tests passed
- `npm run build` — succeeded

## Follow-ups
- Monitor auto-resume behavior in production after a restart
- Consider migrating existing `user_settings.policy` blobs to the split format (low priority — backward compat works)
- The account picker in settings could be enhanced to show more account details (broker, environment)

## 2026-06-30 PR #252 Review Follow-up

### Summary
- Resolved the remaining review blocker by stripping user-level policy fields from legacy/stale `account_strategy_state.policy` blobs before applying the current user-level overlay in both `getPolicy` and `peekPolicy`.
- Added a regression that seeds a stale inactive account row containing `redTeamLlmModel`, clears that user-level field, and verifies it does not reappear or get written back during a later account update.

### Why
- Optional user-level fields disappear from `readUserPolicyFields()` when cleared. Without stripping stale account-row copies first, an old inactive account policy could keep using a cleared model and later write it back into storage.

### Files
- `src/lib/db-profiles.ts`
- `test/per-account-policy-isolation.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-29-tiered-settings.md`

### Verification
- `npm ci` - passed in the temporary PR worktree.
- `npm test -- test/per-account-policy-isolation.test.ts` - first run failed because the regression setup inserted over an already lazily seeded account row; changed the setup to `INSERT OR REPLACE`, then passed with 10 tests.
- `npx tsc --noEmit` - passed cleanly.
- `npm run lint` - passed with 0 errors and 256 existing warnings.

## 2026-06-30 Settings scope/help follow-up

### Summary
- Moved the Strategy Studio entry point out of User -> Connections and into Account -> Strategy.
- Changed Green/Red model and reasoning effort persistence from user-level policy fields to account-scoped strategy fields, with a compatibility seed for older user-level model selections.
- Added compact per-field help affordances and a Settings Glossary in System Help.

### Why
- Strategy prompt, model choice, reasoning effort, scoring weights, and tuning reviews all govern the selected account strategy. Provider API keys remain user-scoped credentials.

### Files
- `app/ui/primitives.tsx`
- `app/dashboard-client.tsx`
- `src/lib/db-profiles.ts`
- `src/lib/types.ts`
- `test/per-account-policy-isolation.test.ts`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-30-settings-scope-help-overhaul.md`
- `STATUS.md`
- `PLAN.md`

### Verification
- `npm test -- test/per-account-policy-isolation.test.ts` - passed, 10 tests.
- `npm run lint` - passed with 0 errors and 255 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 160 files / 1555 tests.
- `npm run build` - passed.

# Pushover Notification Channel Support

## Context & Objective
The user requested adding Pushover as a notification option. This required a schema change to add a `pushover_target` column to the `notification_prefs` table, adding UI configuration fields for the Pushover User Key, and wiring up the dispatcher logic to support Pushover (which was previously conflated with Ntfy under a generic `push` object, though the DB supported token storage).

## Changes Made
- Added a `pushover` object to the `NotifyPrefs` and `NotifyChannelId` types.
- Created `src/db/migrations/063-notification-prefs-pushover.sql` to explicitly document the column addition.
- Registered migration `63` in `src/lib/db.ts` to idempotently add the `pushover_target` column via `ALTER TABLE`. Handled the edge case in `test/persistence-hardening.test.ts` where isolated db migrations apply to partial schemas.
- Modified `src/lib/db-api-keys.ts` to handle saving and loading the new `pushover_target`.
- Separated Pushover dispatch logic in `src/lib/notify.ts`, which now looks up the `pushover_target` via `api.pushover.pushoverToken` and sends an HTTP POST request to `api.pushover.net`.
- Updated `app/console/settings/delivery.tsx` and `app/console/settings/lib.ts` to surface the "Pushover User Key" configuration to the user.

## Decisions & Trade-offs
- Used `pushover_target` as the column name to align with the frontend terminology ("target" or "user key"), whereas the token internally maps to `api.pushover.pushoverToken`.
- When modifying `src/lib/db.ts` for migration 63, the `ALTER TABLE` check utilizes `table_info` to ensure safe, idempotent migration across various testing schemas. Since tests like `persistence-hardening.test.ts` bypass the standard `CREATE TABLE` and evaluate partial schemas, a `try-catch` block was added.
- The `expect(applyVersionedMigrations(db)).toBe(62)` check in tests was incremented to `63`.

## Verification State
- `npm run lint`: Passed (0 errors).
- `npx tsc --noEmit`: Passed (0 errors).
- `npm test`: Full test suite passed successfully. (The failing `test/persistence-hardening.test.ts` due to migration schema dependencies was fully resolved and passes.)
- Tested SQLite migrations directly.

## Next Steps & Blockers
- None. Code is ready to be landed and auto-deployed.

# 2026-07-01 — Account deletion: block while a mobile command is in flight

PR #293 (branch `claude/audit-work-split-f-g-o67jj2`). Addresses a Codex P2 on the account-deletion
change from workstream G.

## Summary / Why

Workstream G added `mobile_commands` to the account-deletion sweep (`DELETE_TABLES_BY_USER_ID`), so
`confirmAndDeleteAccount` now deletes that user's queued/running command rows. But
`getAccountDeletionBlockers()` only counted running strategy runs, placing proposals, and pending
reconciliation fills — NOT in-flight mobile commands. So if a mobile command was already claimed by a
worker (`status='running'`) when the user confirmed deletion, the worker still held the payload and
could keep mutating policy/watchlists, or try to finish against a row that was just deleted.

## Fix

- `AccountDeletionBlockers` gains `activeMobileCommands`.
- `getAccountDeletionBlockers()` counts `mobile_commands` rows for the user with
  `status IN ('queued','running')` (the two in-flight statuses; `succeeded`/`failed`/`cancelled` are
  terminal and safe to delete).
- `confirmAndDeleteAccount`'s blocker sum includes `activeMobileCommands`, so deletion 409s (with the
  blockers payload) until the command drains — same behavior as the existing trading-activity blockers.
- UI (`app/dashboard-client.tsx`): the client `blockers` type mirror + the "Deletion is blocked…"
  message now include the mobile-command count. (The total-count reducer already summed it via
  `Object.values` at runtime; this makes the type and the reason message truthful.)

## Files

- `src/lib/account-deletion.ts` — blockers type + count query + confirm sum.
- `app/dashboard-client.tsx` — client blockers type + blocked-reason message.
- `test/account-deletion.test.ts` — new test: a `running` mobile command blocks deletion; a
  `succeeded` one does not.

## Verification

`npx tsc --noEmit` 0 · `npm run lint` 0 errors · `npm test` **2056** · `npm run build` ok. (Verified on
branch HEAD `e4ff311`; the fix is layered on top of the owner's account-aware budget work.)

## Follow-ups

- None. Terminal-status mobile commands are intentionally not blockers. If a future need arises to
  *drain* (cancel) in-flight commands as part of deletion rather than block, that's a separate design.

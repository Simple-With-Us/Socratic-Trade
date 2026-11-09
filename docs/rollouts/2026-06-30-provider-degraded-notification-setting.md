# 2026-06-30 - Provider Degraded notification setting

## Summary
Fixed the Settings -> Notifications `provider_degraded` checkbox so selecting it survives the
policy save/reload path.

## Why
The UI and TypeScript union knew about `provider_degraded`, but `PUT /api/policy` filtered
`notificationSettings.enabledEvents` through a separate hard-coded runtime allowlist that omitted
the event. The controlled checkbox could fire `onChange`, but the API stripped the saved value and
the next dashboard reload showed it unchecked again.

## Files
- `app/api/policy/route.ts` - validates notification events against the shared runtime list.
- `src/lib/types.ts` - exposes `NOTIFICATION_EVENT_TYPES` and derives `NotificationEventType` from it.
- `src/lib/defaults.ts` - derives default enabled notification events from the shared list.
- `test/policy-notification-events.test.ts` - covers persisting `provider_degraded` and filtering an unknown event.
- `STATUS.md`, `PLAN.md` - handoff notes for this fix.

## Verification
- `bash scripts/npm-ci-with-shared-deps.sh` - installed dependencies in the fresh Codex worktree.
- `npx vitest run test/policy-notification-events.test.ts` - 1 test passed.
- `npm run lint` - passed with 0 errors and 256 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - 160 files / 1539 tests passed.
- `npm run build` - passed; Next production build completed successfully.
- `bash scripts/land.sh` - first post-merge attempt passed `tsc` but hit two
  `test/persistence-notification.test.ts` full-suite failures; immediate targeted rerun
  `npx vitest run test/persistence-notification.test.ts` passed 17/17. Second `land.sh`
  run passed `tsc`, `npm test` (160 files / 1539 tests), and `npm run build`, then pushed
  `codex/provider-degraded-checkbox` and opened PR #259.

## Follow-ups
- None for this checkbox bug.

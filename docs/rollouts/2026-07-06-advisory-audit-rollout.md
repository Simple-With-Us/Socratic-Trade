# Advisory Audit Rollout

## Summary
Render the new advisory audit kinds in the console Alert Center and activity feed. The audit kinds added are `deterministic_bear_veto`, `red_team_veto_overridden`, `prompt_injection_suspected`, and `evidence_age_anomaly`.

## Why
This enables operators to monitor advisory-level AI risk events and overrides directly on the unified dashboard and activity feed without digging into raw logs.

## Files Touched
- `src/lib/types.ts`: Registered new advisory kinds in `NOTIFICATION_EVENT_TYPES`.
- `src/lib/dashboard-ui.ts`: Configured formatting and descriptions for rendering these kinds in the Alert Center (`formatNotificationDisplay`, `notificationDetail`).
- `src/lib/dashboard-feed.ts`: Added visualization logic to `formatAuditEvent` for these events in the unified Activity Feed.
- `src/lib/dashboard.ts`: Identified and mapped these audit rows, injecting them into the user's dashboard notifications flow.

## Verification
- `npm run lint` (ignored pre-existing warnings in unaffected files).
- `npx tsc --noEmit` (passed).
- `npm test` (passed for affected files).
- `npm run build` (passed, successful optimized production build).

## Follow-ups
None immediately.

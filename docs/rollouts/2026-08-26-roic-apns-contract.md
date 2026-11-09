# 2026-08-26 — APNs contract row for roic_status_advisory

## Context & Objective
PR #3107 (`agent/antigravity-ui-fixes`, `f22b92ed`) registered `roic_status_advisory` so ROIC.ai can appear under EarningsCalls.dev in Settings.  Hosted verify then failed because the iOS push-contract table was not updated.

## Changes Made
Added the missing contract Row so `test/apns-deep-link-contract.test.ts` matches `NOTIFICATION_EVENT_TYPES`.  The server already maps unknown kinds to `/console/activity?tab=notifications`.

- `ios/SocraticTradeTests/PushNotificationTests.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-26-roic-apns-contract.md`

## Decisions & Trade-offs
Did not change `pushDeepLink` — the default Activity/notifications path is the same pairing used by `earningscalls_entitlement_blocked`.  Did not expand the iOS Alerts Center attention filter; that is product copy, not the CI break.

## Verification State
- `npx vitest run test/apns-deep-link-contract.test.ts` (run after the Row was added)
- `verify` on #3107 is a gate over `verify-hosted`; it failed only because hosted failed
- Autofix (`Codex Autofix`) hit its 60-turn cap and did not produce a fix

## Next Steps & Blockers
Merge this stacked PR into `agent/antigravity-ui-fixes` so #3107 can re-run verify.

## Zero-Code Findings
None.  This was a missing contract row, not a flake.

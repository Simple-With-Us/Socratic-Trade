# 2026-08-18 — iOS UX owner cut (IRA wash-sale, ordinary copy, bidirectional caps)

## Context & Objective

Owner cut 2026-08-17 ~8:45pm CT: Roth/IRA Guardrails must not show “Wash-Sale Guard: On”; Settings must not talk like a ticket (APNs / production push / `policy.patch` / console-only); iOS must set Ask-First **and** return to Autopilot, and raise **or** lower caps, without sending the user to the website.

Did not clone locally.  Did not touch healthy in-flight PRs #2792 #2798 #2800 #2794 #2812 #2816 #2818 #2819 #2820 #2814.  Layered on #2814’s “no owner-note UI” intent (Home / Insights / Data Sources copy) rather than fighting that PR.

## Changes Made

- IRA / Roth tax card matches web N/A: same-account wash sale is not applicable; cross-account replacement reads ignored unless blocked.  Taxable Wash-Sale Guard / Handling (`auto`) never render on an IRA, including when the live card already says Roth IRA in display words.  Taxable accounts still show Wash-Sale Guard.
- Green / Red Team never show `__rotate__`.  Seat value is lowercase “rotate models” (ordinary words; no underscores; no fallback slug).
- Swept every user-facing string in `ios/SocraticTrade`: no `/api/policy`, “latest snapshot”, phone-safe, `policy.patch`, console-only, APNs/SSE/sandbox/production-push, or dunder tokens.  Activity “Commands” is “Recent Actions”.  Login / Insights / Coach / Scan / sign-out / errors use ordinary app copy.  Notes for Jay stay in this PR, not the UI.
- Push Settings footer is “Alerts on.”  Apple / empty-token / sandbox / production jargon is sanitized out of the footer.
- Guardrails and Account & Settings edit Ask-First ↔ Autopilot and raise / lower / switch dollar ↔ % of NAV caps through existing `policy.patch`.  Autopilot types `AUTOPILOT`.  Live loosening types `CONFIRM` when typed-confirm is on.  No extra real-money scare copy.

Touched files:

- `ios/SocraticTrade/PolicyTightening.swift`
- `ios/SocraticTrade/GuardrailsView.swift`
- `ios/SocraticTrade/PushNotifications.swift`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/DataSourcesSettings.swift`
- `ios/SocraticTrade/InsightsView.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTradeTests/PolicyTighteningTests.swift`
- `ios/SocraticTradeTests/PushNotificationTests.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/CoachView.swift`
- `ios/SocraticTrade/ScanView.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/CLAUDE.md`
- `docs/phase-6-customization-risk-notifications.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-18-ios-ux-owner-cut.md`

## Decisions & Trade-offs

- Did not rebuild Strategy / Macro / Connections.  Universe edits still live on Strategy; the copy no longer says “desktop console only.”
- Did not add `iraWashSaleHandling` to the mobile `policy.patch` allowlist.  Display matches web; toggling Block vs Ignore on an IRA remains the existing policy PUT on web.
- #2814 is still open and also edits Home / Insights / Guardrails / Data Sources.  This PR changes those same user-visible strings to satisfy the later owner cut.  Merge may need a text reconcile, not a behavior fight.
- This Cloud VM has no Xcode.  `xcodebuild` could not run.  Swift tests are added; first compile will be CI / a Mac.

## Verification State

- `npm run lint` — passed (errors only; existing warning backlog).
- `npx tsc --noEmit` — passed.
- `npm test` — started; this VM hung ~20m into the suite after unrelated network/env failures (`sec.gov` 404s, TwelveData, vector-db receipts, server-metrics).  No JS product files changed in this PR.  Killed the hung run.
- `npm run build` — passed (`next build --webpack`).
- `xcodebuild` — **not available** on this VM.  First Swift compile is CI / a Mac.

## Next Steps & Blockers

- Rebased onto `main` at `995b7eee` (#2815).  Real conflicts were Data Sources footer, Home checklist, and Login privacy note.  Kept #2815 Terms/Privacy clickwrap and jargon-free session copy; kept #2821 Daily AI Budget and number rows.
- CI `verify` (JS) plus iOS compile on the Mac runner / TestFlight ship after merge.
- Reconcile copy with #2814 if that PR is still open at merge time.
- Do not steal the reserved PRs listed above.  Do not merge this PR from the agent seat.

## Zero-Code Findings

None.  This is an implementation PR.

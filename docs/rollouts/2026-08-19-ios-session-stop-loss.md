# iOS session snapshot clear, edit alerts, nested stop-loss decode

## Context & Objective

Part II of `docs/reviews/2026-08-18-full-app-expert-review.md` clusters `ios-state-outcome-truth` and `web-ios-contract-drift` (stop-loss only).  Sign-out left a UserDefaults snapshot that cold launch re-read as authenticated; guardrail edit errors rendered behind the settings sheet and were cleared by `load()`; `FullPolicy` decoded stop percents from top-level keys while `GET /api/policy` nests them under `riskRules`.

## Changes Made

- `clearLocalSession()` now removes the disk snapshot and its saved-at timestamp; init restores the real capture time instead of `Date()`.
- `load()` only clears `error` when recovering from a prior snapshot load failure, so queued `policy.patch` failures survive the post-submit refresh.
- `StoreTransientAlerts` presents `store.error` and `successMessage` as modal alerts; removed the scroll-top `InlineErrorBanner` from `SnapshotScaffold`.
- `FullPolicy` decodes `stopLossPct`, `trailingStopPct`, and `shortStopLossPct` from nested `riskRules` with top-level fallback.
- XCTest fixtures for nested policy JSON and session cache clearing.

**Files touched**

- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `docs/rollouts/2026-08-19-ios-session-stop-loss.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs

- Swift nested decode chosen over flattening `app/api/policy/route.ts` so web clients stay unchanged.
- No Keychain cookie move — no existing helper in the iOS tree; out of scope for this minimum PR.
- Alerts on `MobileControlView` and `AccountSettingsView` so sheet edits surface modally; no TestFlight upload.

## Verification State

Cloud VM has no Xcode.  iOS XCTest runs in CI `verify` (mac runner).

```bash
# Not runnable on Linux cloud VM — CI gate:
xcodebuild test -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
```

New tests: `testFullPolicyDecodesNestedRiskRulesStopPercents`, `testClearLocalSessionRemovesDiskSnapshot`, `testInitUsesPersistedSnapshotTimestamp`, `testColdLaunchAfterSignOutDoesNotRestoreCachedSnapshot`.

## Next Steps & Blockers

- Owner: ship next TF when ready (not part of this PR).
- Broader `web-ios-contract-drift` fixture program remains out of scope.

## Zero-Code Findings

None.

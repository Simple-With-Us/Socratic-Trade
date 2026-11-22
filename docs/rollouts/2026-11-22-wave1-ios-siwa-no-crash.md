# Rollout: Eliminate iOS SIWA UIWindowScene Auth Crash (ST-4649)

## Context & Objective
ST-4649 resolves audit item X1/N1 (`docs/audits/2026-11-21-zc-ios-perf.md`, `docs/audits/2026-11-21-zc-ios-ux.md`), removing a lethal `preconditionFailure` in iOS presentation context resolution.  The Sign in with Apple and Web Auth presentation paths previously crashed the application process when no active `UIWindowScene` was present at presentation time.

## Changes Made
- **Architectural & Logical Changes**:
  - Refactored `WebAuthContextProvider` in `ios/SocraticTrade/LoginView.swift` to change access level from `private` to `internal` so unit tests can access it directly.
  - Added `resolveKeyAnchor(from scenes: [UIWindowScene]) -> ASPresentationAnchor?` which inspects key windows across scenes first, falls back to `scene.windows.first ?? UIWindow(windowScene: scene)`, and safely returns `nil` when `scenes.isEmpty`.
  - Added `connectedWindowScenes` property isolated to `@MainActor`.
  - Replaced `preconditionFailure("No UIWindowScene available for auth presentation")` in `keyAnchor()` with a non-trapping best-effort fallback `UIWindow(frame: .zero)`.
  - Added pre-flight guards to `beginAppleSignIn`, `beginAppleSignInPrepared`, `beginWebAuth`, and `beginWebAuthPrepared` verifying an anchor scene is resolvable before starting auth or creating authorization requests.
  - Surfaced clear, ordinary user-facing error copy (`"Sign-in window is unavailable right now.\u{00A0} Bring Socratic Trade to the foreground and try again."`) and reset flow without crashing.
  - Added XCTest unit test coverage verifying `resolveKeyAnchor(from: []) == nil`, `keyAnchor()` does not trap, and user-facing copy avoids framework leaks while adhering to two-space sentence boundaries.

- **Files Touched**:
  - `ios/SocraticTrade/LoginView.swift`
  - `ios/SocraticTradeTests/MobileSessionHardeningTests.swift`
  - `ios/SocraticTradeTests/UserFacingCopyTests.swift`
  - `STATUS.md`
  - `docs/rollouts/2026-11-22-wave1-ios-siwa-no-crash.md`

## Decisions & Trade-offs
- **Non-trapping fallback**: `UIWindow(frame: .zero)` is returned if `resolveKeyAnchor` cannot find an active scene, matching grok/ZC audit recommendations to never trap on production auth presentation paths.
- **Strict file scope**: Kept `MobileSessionHardening.swift` untouched so `git diff` touches only `LoginView.swift`, test files, `STATUS.md`, and this rollout doc.
- **Actor isolation**: Isolated `connectedWindowScenes`, `resolveKeyAnchor`, and `keyAnchor` to `@MainActor`, bridging cleanly in `presentationAnchor(for:)` via `MainActor.assumeIsolated`.

## Verification State
- Inspected `git diff` to ensure precise syntax conformity and adherence to file scope boundaries.
- Swift compilation & XCTest run on hosted CI via `.github/workflows/ios-build.yml` per fleet rule in `AGENTS.md` (no local `xcodebuild`).

## Next Steps & Blockers
- Push branch `ag/wave1-ios-siwa-crash` to origin.
- Verify `ios-build` CI passes cleanly.
- Report completion to coordinator.

## Zero-Code Findings
- N/A.

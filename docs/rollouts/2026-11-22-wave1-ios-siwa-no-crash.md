# Rollout: Eliminate iOS SIWA UIWindowScene Auth Crash (ST-4649)

## Context & Objective
ST-4649 resolves audit item X1/N1 (`docs/audits/2026-11-21-zc-ios-perf.md`, `docs/audits/2026-11-21-zc-ios-ux.md`), removing a lethal `preconditionFailure` in iOS presentation context resolution.  The Sign in with Apple and Web Auth presentation paths previously crashed the application process when no active `UIWindowScene` was present at presentation time.

## Changes Made
- **Architectural & Logical Changes**:
  - Refactored `WebAuthContextProvider` in `ios/SocraticTrade/LoginView.swift` to conform to both `ASWebAuthenticationPresentationContextProviding` and `ASAuthorizationControllerPresentationContextProviding`.
  - Added scene-attached `fallbackAnchor: ASPresentationAnchor` captured on `@MainActor` at session creation time, avoiding any unattached `UIWindow(frame: .zero)` or deprecated `UIWindow()` calls (strictly conforming to the 2026-08-06 fleet recall).
  - Added `resolveKeyAnchor(from scenes: [UIWindowScene]) -> ASPresentationAnchor?` which inspects key windows across scenes first, falls back to `scene.windows.first ?? UIWindow(windowScene: scene)`, and safely returns `nil` when `scenes.isEmpty`.
  - Added `connectedWindowScenes` property isolated to `@MainActor`.
  - Made `keyAnchor() -> ASPresentationAnchor?` non-trapping, returning `resolveKeyAnchor(from: connectedWindowScenes)` (zero detached window allocations).
  - Implemented thread-safe `resolvedAnchorSync() -> ASPresentationAnchor` handling off-main invocations via `DispatchQueue.main.sync` and main thread via `MainActor.assumeIsolated`.
  - Added pre-flight guards to `beginAppleSignIn`, `beginAppleSignInPrepared`, `beginWebAuth`, and `beginWebAuthPrepared` verifying an anchor scene is resolvable before starting auth or creating authorization requests.
  - In `AppleSignInCoordinator`, retained `contextProvider: WebAuthContextProvider` in `retained[key]` for the lifetime of the request, passing it as `controller.presentationContextProvider` (solving weak reference deallocation).
  - Surfaced clear, ordinary user-facing error copy (`"Sign-in window is unavailable right now.\u{00A0} Bring Socratic Trade to the foreground and try again."`) and reset flow without crashing.
  - Added XCTest unit test coverage verifying `resolveKeyAnchor(from: []) == nil`, `keyAnchor()` does not trap, and user-facing copy avoids framework leaks while adhering to two-space sentence boundaries.

- **Files Touched**:
  - `ios/SocraticTrade/LoginView.swift`
  - `ios/SocraticTradeTests/MobileSessionHardeningTests.swift`
  - `ios/SocraticTradeTests/UserFacingCopyTests.swift`
  - `STATUS.md`
  - `docs/rollouts/2026-11-22-wave1-ios-siwa-no-crash.md`

## Decisions & Trade-offs
- **Scene-attached fallback**: Captures pre-flight scene-attached window anchor rather than creating detached windows without scenes, adhering to iOS 26 scene architecture rules.
- **Thread safety**: Supported off-main presentation context requests safely without triggering runtime crashes.
- **Strict file scope**: Kept `MobileSessionHardening.swift` untouched so `git diff` touches only `LoginView.swift`, test files, `STATUS.md`, and this rollout doc.

## Verification State
- Inspected `git diff` to ensure precise syntax conformity and adherence to file scope boundaries.
- Swift compilation & XCTest run on hosted CI via `.github/workflows/ios-build.yml` per fleet rule in `AGENTS.md` (no local `xcodebuild`).

## Next Steps & Blockers
- Push branch `ag/wave1-ios-siwa-crash` to origin.
- Verify `ios-build` CI passes cleanly.
- Report completion to coordinator.

## Zero-Code Findings
- N/A.

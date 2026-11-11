# ST-4596: iOS Keychain session cookie storage (#5131)

## Context & Objective

Auth.js session cookies previously lived only in the default `URLSession` persistent cookie jar.  This PR persists/restores session archives in the Keychain and keeps the live API client on an ephemeral in-memory jar.  Optional app lock was split out to **ST-4605** on branch `gb-engineer/st-4596-app-lock` (no PR yet).

## Changes Made

- `SessionKeychain.swift`: `KeychainSessionStore`, `SessionCookieCoordinator`, archive apply/clear, Auth.js chunked cookie names, host-only vs domain-scoped restore, origin trust, transient vs corrupt Keychain failures.
- `MobileAPIClient` / `MobileStore`: ephemeral jar, async restore task (single-flight), defer authenticated `load()` until restore completes, persist on successful session, sign-out surfaces Keychain delete failures.
- `SocraticTradeApp`: cancellable foreground resume (`AppForegroundResume`, `ScenePhaseResumeGate`); stop SSE when `isAuthenticated` flips false.
- `AdminPortalView`: refresh WKWebView session cookies when fingerprint changes; fingerprint uses SHA-256 of cookie values (no raw bearer tokens in memory).
- Unit tests: `SessionKeychainTests`, `MobileStoreSessionPersistenceTests`, `AppLiveSessionResumeTests`, `AppForegroundResumeTests`, `AdminPortalSessionFingerprintTests`.

### Files touched (iOS)

- `ios/SocraticTrade/SessionKeychain.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTrade/AdminPortalView.swift`
- `ios/SocraticTrade/AppForegroundResume.swift`
- `ios/SocraticTrade/AppLiveSessionResume.swift`
- `ios/SocraticTrade/ScenePhaseResumeGate.swift`
- `ios/SocraticTradeTests/*` (session persistence + keychain + resume tests)
- `ios/project.yml` (Face ID string retained for follow-up ST-4605 branch; not used in this PR)

## Decisions & Trade-offs

- Portfolio snapshot cache stays in `UserDefaults` (UI state, not credentials).
- App lock code removed from #5131 to stop review scope creep; full app-lock stack lives on `gb-engineer/st-4596-app-lock` for ST-4605.
- Admin portal fingerprint hashes values so coordinator state does not retain plaintext session tokens.

## Verification State

```bash
# Hosted PR CI (required):
# verify-ios / xcodebuild (unsigned) — .github/workflows/ios-build.yml
# verify — tsc, vitest, next build
```

Linux cloud seat: no local `xcodebuild`.

## Next Steps & Blockers

- Merge #5131 after `verify` + `verify-ios` green on PR head.
- Land ST-4605 app-lock PR from `gb-engineer/st-4596-app-lock`.
- Owner smoke: sign in, kill app, relaunch (Keychain restore), admin portal after session rotation.

## Zero-Code Findings

None.

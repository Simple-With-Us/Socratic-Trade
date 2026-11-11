# ST-4596: iOS Keychain session storage and optional app lock

## Context & Objective

Auth.js session cookies previously lived only in the default `URLSession` persistent cookie jar (`HTTPCookieStorage.shared` via `URLSession.shared`).  ST-4596 (ios-02 / ios-18) moves durable session storage into the Keychain and adds an optional biometric app lock, off by default.

## Changes Made

- Introduced `SessionKeychain.swift` with `KeychainSessionStore` (`kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, service = bundle id), `SessionCookieCoordinator`, and Auth.js session cookie name matching (including chunked `.0`…`.7` names).
- `MobileAPIClient` now uses an ephemeral in-memory `URLSession` by default; session cookies round-trip through the Keychain on launch, after sign-in, and are deleted on sign-out.  One-time migration copies a legacy shared-jar session into the Keychain and clears it from `HTTPCookieStorage.shared`.
- Optional app lock: `AppLock.swift` + Settings toggle (`Require App Lock`), Face ID / Touch ID / passcode via `LAContext.deviceOwnerAuthentication`, 60s background grace, `NSFaceIDUsageDescription` in `ios/project.yml`.
- Unit tests: `SessionKeychainTests.swift`, `AppLockTests.swift`; adjusted `AccountScopeAndMoneyActionTests` session cookie name.

### Files touched

- `ios/SocraticTrade/SessionKeychain.swift` (new)
- `ios/SocraticTrade/AppLock.swift` (new)
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/AdminPortalView.swift`
- `ios/SocraticTrade/PushNotifications.swift`
- `ios/project.yml`
- `ios/SocraticTradeTests/SessionKeychainTests.swift` (new)
- `ios/SocraticTradeTests/AppLockTests.swift` (new)
- `ios/SocraticTradeTests/AccountScopeAndMoneyActionTests.swift`

## Decisions & Trade-offs

- **What still persists outside the Keychain:** the portfolio snapshot cache remains in `UserDefaults` (`cached_mobile_snapshot_data`) — account UI state, not the auth credential.  URLSession now uses `URLSessionConfiguration.ephemeral` so cookies are in-memory only during a process lifetime; the Keychain holds the durable session archive.  `HTTPCookieStorage.shared` is no longer written by the app after migration (any legacy session is moved once, then cleared).  Admin portal WKWebView uses a non-persistent data store; session cookies are copied per load from the native jar.
- **LoginView untouched** — hooks are only `MobileStore` sign-in / sign-out / `load()` and `MobileAPIClient` session construction.
- **Push coordinator** rebinds to `MobileStore.client` at bootstrap so push register/delete share the same cookie jar.

## Review follow-up (PR #5131)

- App lock: `@Observable` controller, grace-period timestamp cleared on foreground return, device-auth guard + escape hatch, resume `startEvents()`/`load()` after unlock.
- Session: Keychain `SecItemUpdate` save path, `httpOnly` preserved in archives, expired archives skipped (Keychain cleared when all stale), sign-out retries Keychain delete and surfaces failure.

## Verification State

Linux cloud seat — Swift compile not run locally.

```bash
# Not run on Linux (no xcodebuild):
# .github/workflows/ios-build.yml on PR (hosted macos-latest)

npx tsc --noEmit   # not required for iOS-only change; not run
npm test           # not run (no TS changes)
```

Await `ios-build` / `verify-ios` on the PR branch.

## Next Steps & Blockers

- Confirm hosted `ios-build` is green on the PR.
- Rebase on `main` if ST-4594 lands first (auth header / LoginView overlap).
- After merge: owner smoke on device — sign in, kill app, relaunch session restore; toggle app lock, background > 60s, unlock.

## Zero-Code Findings

None.

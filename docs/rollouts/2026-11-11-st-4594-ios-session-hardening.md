# 2026-11-11 — ST-4594: iOS adopts ST-2599 session hardening

## Context & Objective

ST-2599 already enforces server-backed mobile sign-in when the client sends a real handoff nonce, an Apple nonce, or `x-socratic-mobile-session-hardening: 1`.  This change teaches the native app those calls so a later release can drop the `__legacy_compat__` paths.  Older shipped builds still need those paths, so this PR does not remove them.

## Changes Made

Google and GitHub sign-in posts the PKCE `codeChallenge` to `POST /api/mobile/auth/handoff-prepare` and puts the returned nonce on the auth-start callback as `handoff_nonce`.  The app refuses `__legacy_compat__` and does not start the browser session without a server-issued nonce.  Native Sign in with Apple fetches `GET /api/mobile/auth/apple/nonce`, sets `ASAuthorizationAppleIDRequest.nonce` to the SHA-256 hex of that value, and posts the raw nonce with the identity token.  A nonce fetch failure shows a clear error and does not fall back.  The server accepts an identity-token nonce claim that is either the issued nonce or that SHA-256 hex, because Apple copies `request.nonce` into the token and does not hash it again.  Handoff prepare, the Apple nonce fetch, the Apple sign-in post, and the web-auth exchange send `x-socratic-mobile-session-hardening: 1`.  `ASWebAuthenticationSession` cannot attach that header to the browser navigation.  A real `handoff_nonce` is what makes auth-start and auth-redirect strict.  Sign-out sends DELETE `/api/mobile/push/register` for the current account before it clears session cookies.  A new sign-in deletes that row only after the replacement login succeeds, and it does so with the previous account's cookies restored for that DELETE.  A failed login leaves the old push row in place.  Each Apple attempt keeps its own server nonce.  A transient push upload keeps the last registered token and retries once.  Switching broker accounts keeps the signed-in user, so it does not unregister.  A 409 from push registration is surfaced once.  Further uploads of that token stop until the next sign-in or a successful unregister.  The next sign-in sends one register attempt, and a fresh 409 arms the hold again so APNs callbacks do not loop.

### Files touched

- `ios/SocraticTrade/MobileSessionHardening.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/PushNotifications.swift`
- `ios/SocraticTradeTests/MobileSessionHardeningTests.swift`
- `src/lib/auth/apple-signin-nonce.ts`
- `app/api/mobile/auth/apple/route.ts`
- `test/apple-auth-route.test.ts`
- `docs/rollouts/2026-11-09-st-2599-session-hardening.md`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The browser redirect cannot carry the hardening header.  Strictness on that hop comes from a handoff nonce that is not `__legacy_compat__`.  Apple's nonce rule and the existing equality tests both have to pass, so the server matches the raw issued nonce or its SHA-256 hex and still consumes the raw value from the POST body.  Keychain and app lock stay in ST-4596.  The account-change DELETE briefly restores the previous account's cookies, then puts the new session back.  Session expiry cannot DELETE the push row because the cookies are already dead.  The next sign-in clears the local hold and sends one register.  The account that already owns the token is accepted.  A different account gets one 409 and the hold returns.  Legacy server paths stay until this build is on TestFlight and the App Store.

## Verification State

```bash
npm test -- test/st-2599-auth-sessions.test.ts test/mobile-auth-redirect-route.test.ts test/apple-auth-route.test.ts test/apns-register-route.test.ts test/mobile-auth-handoff.test.ts
```

Swift is not compiled on this Linux seat.  `ios-build.yml` on GitHub-hosted `macos-latest` is the compile and XCTest gate.  New XCTest coverage builds the handoff, Apple, and exchange requests, refuses a legacy nonce, records unregister-before-cookie-clear, keeps a distinct nonce per overlapping Apple attempt, deletes the previous push row only after Apple sign-in succeeds, leaves that row in place when Apple sign-in fails, retries a transient push upload without dropping the token, and allows one register after the next sign-in.  Targeted server tests: 41 passed.

## Next Steps & Blockers

Land the PR after `verify` and `ios-build` are green.  Remove `__legacy_compat__` only after this build is on TestFlight and the App Store.  ST-4596 remains the Keychain and app-lock change.

## Zero-Code Findings

None.

# PR #1856 Review Remediation

**Date:** 2026-07-21

**Owner:** CODEX

**Branch:** `codex/pr1856-auth-review-prep` (local only, based on
`origin/agent/antigravity-key-deletion-tombstone`)

## Summary

Prepared local fixes for all seven unresolved review threads on PR #1856 without changing GitHub,
CI, merge, or production state. The remote branch remains blocked.

## Findings and decisions

1. The PR head had replaced the 1,900-line `src/lib/db-api-keys.ts` implementation with two lines of
   placeholder prose. Restored the real module before applying key-deletion changes.
2. Tombstones now apply only to environment-migrated keys owned by the primary `local` user. Tenant
   deletes remain hard deletes, and legacy tenant tombstones are treated as absent, preserving the
   intended operator-funded LLM fallback.
3. The custom URL scheme no longer carries a session JWT. It receives only a random two-minute,
   one-time code plus state. The server stores the session encrypted, binds the code to state and
   PKCE S256, consumes it atomically over HTTPS, and sets an HttpOnly session cookie without putting
   the token in the response body.
4. Native Google/GitHub auth now enters through `/api/mobile/auth/start`, which invokes the Auth.js
   server `signIn` action. The invalid provider-specific GET flow was removed.
5. The iOS target now declares the Apple Sign-In entitlement and includes a complete opaque AppIcon
   catalog referenced by the generated Xcode project.
6. `package-lock.json` is committed. CI/E2E dependency installs and cache keys again use `npm ci` and
   the lockfile. Runner-label and cancellation policy changes are intentionally left to PR #1857.

## Files

- `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`, `.gitignore`
- `app/api/mobile/auth/start/route.ts`, `app/api/mobile/auth-redirect/route.ts`,
  `app/api/mobile/auth/exchange/route.ts`, `middleware.ts`
- `src/lib/mobile-auth-exchange.ts`, `src/lib/db-api-keys.ts`,
  `src/lib/st-primary-bridge-writer.ts`
- `ios/project.yml`, `ios/SocraticTrade.xcodeproj/project.pbxproj`,
  `ios/SocraticTrade/SocraticTrade.entitlements`, `ios/SocraticTrade/LoginView.swift`,
  `ios/SocraticTrade/MobileAPIClient.swift`, `ios/SocraticTrade/MobileStore.swift`,
  `ios/SocraticTrade/Assets.xcassets/**`
- `test/mobile-auth-exchange.test.ts`, `test/key-resolution-tiering.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, and the three corrected 2026-07-21 rollout notes

## Verification

- `npm ci --no-audit --no-fund` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH ./node_modules/.bin/vitest run test/key-resolution-tiering.test.ts test/mobile-auth-exchange.test.ts --reporter=verbose` — 2 files, 37 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH ./node_modules/.bin/tsc --noEmit` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with zero errors.
- `./node_modules/.bin/vitest run test/data-providers.test.ts test/policy.test.ts test/outcome-engine.test.ts test/usage-budget-strategy-integration.test.ts test/strategy-money-path-f-g.test.ts --reporter=verbose` — 5 files, 184 tests passed. These tests validate pre-existing PR #1856 commit `444bea37`; that six-file commit is independent of this review remediation and three-way merges cleanly onto PR #1857.
- `plutil -lint ios/SocraticTrade/SocraticTrade.entitlements ios/SocraticTrade/Info.plist` — passed.
- `jq empty ios/SocraticTrade/Assets.xcassets/Contents.json ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/Contents.json` — passed.
- `xcodebuild -project ios/SocraticTrade.xcodeproj -scheme SocraticTrade -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` — passed.
- Full `npm test` — interrupted after approximately 46 minutes (exit 130) with no emitted test failure because several concurrent fleet Vitest gates saturated the shared host.
- `npm run build` — interrupted during webpack compilation after approximately 49 minutes (exit 130) with no emitted compiler failure under the same shared-host contention. Hosted CI remains required.
- A first Node 24 focused-test attempt failed before assertions because `better-sqlite3` had been compiled under Node 26 (`NODE_MODULE_VERSION 147`, expected 137). `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm rebuild better-sqlite3` repaired the local-only native dependency; the exact 37 tests then passed under Node 24 as recorded above.

## Follow-ups / ordering

1. Do not push, resolve threads, rerun hosted CI, merge, or deploy from this checkpoint.
2. Land PR #1857 first so unavailable `trading-live` jobs and cancellation thrash are corrected.
3. Refresh #1856 over the landed infrastructure change and explicitly preserve its stacked
   relationship with PR #1851 before pushing the review fixes.
4. Reply to and resolve each of the seven threads only after its fix is on the remote PR head; require
   a durable green `verify` and all auxiliary checks before protected merge and production receipt.

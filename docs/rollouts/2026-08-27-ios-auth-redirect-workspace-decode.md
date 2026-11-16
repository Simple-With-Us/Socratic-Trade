# 2026-08-27 — iOS OAuth return-to-app + workspace decode (both owner-reported, both root-caused live)

## Context & Objective

Owner re-reported after #3116/#3117: (A) Google/GitHub sign-in completes but the
ASWebAuthenticationSession sheet loads the signed-in mobile WEBSITE instead of
returning to the app; (B) Apple sign-in works, then "Couldn't load your workspace.
Try again."  Owner directed the Grok local agent to implement; both Grok dispatch
modes died (its 127.0.0.1:8317 completion endpoint refused; the leader-socket retry
produced nothing — the fleet's known seat-mcp grok empty-death), so MONET landed the
fixes directly per the owner's fallback.

## Root causes (verified against production, not theorized)

- **(A)** `sameOriginCallback` in `app/api/mobile/auth-start/route.ts` validated the
  incoming absolute callbackUrl against `new URL(request.url).origin` — inside the
  Coolify container that is the INTERNAL origin, not `https://socratictrade.com`, so
  every legitimate callback failed the check and collapsed to "/".  Verified live:
  the `__Secure-authjs.callback-url` cookie held the bare origin.  After the provider
  callback, Auth.js sent the sheet to the site root; the `socratictrade://auth`
  handoff never fired.
- **(B)** That alert text is `MobileAPIError.decoding` (MobileAPIClient.swift:36).
  The server's `EquityCurvePoint` (src/lib/types.ts) keys curve points by
  `timestamp`; the shipped Swift `EquityCurvePoint` hard-required `date`.
  `keyNotFound(date)` → `PerformanceSummary` throws → `performance` was a hard
  `try` decode → the WHOLE snapshot decode failed.  Verified by fetching the live
  authenticated snapshot (session minted in-container, never printed) and diffing
  its schema against the shipped models.  #3117's latency theory was wrong — the
  server half of that PR is still a real improvement, but not this bug.

## Changes Made

- `src/lib/mobile-auth-start.ts` (new) — `sameOriginCallback` accepts the resolved
  public origin or the canonical origin and still clamps cross-origin to "/".  The
  origin itself comes from the repo's existing `resolvePublicAppOrigin()`
  (`src/lib/public-origin.ts`), NOT from `request.url` and NOT from forwarded headers.
- `app/api/mobile/auth-start/route.ts` — resolves the origin via
  `resolvePublicAppOrigin(request)` and uses it for both the callback clamp and the
  login fallback; helpers moved out (route modules may only export handlers).
- `src/lib/mobile-equity-curve-compat.ts` (new) + `app/api/mobile/snapshot/route.ts` —
  every live/paper equity-curve point on the MOBILE wire now also carries
  `date` (= `timestamp`); console shape untouched.  Fixes ALL shipped builds on deploy.
- `ios/SocraticTrade/MobileModels.swift` — `EquityCurvePoint` decodes `date` OR
  `timestamp`; `MobileSnapshot.init` decodes `performance` with the defensive
  `(try? ...)` pattern so display-only enrichment can never blank the workspace again.
- Tests: `test/mobile-auth-start.test.ts` (rewritten against the lib; covers the
  internal-origin regression case), `test/mobile-equity-curve-compat.test.ts` (new),
  two new XCTests in `MobileModelsTests.swift` (timestamp-keyed points decode; fully
  malformed performance degrades to nil).

## Decisions & Trade-offs

- Server-side compat alias chosen over renaming the shared `EquityCurvePoint` type —
  the console consumes `timestamp` and must not churn.
- The origin is resolved with `resolvePublicAppOrigin()` (configured
  `NEXT_PUBLIC_SITE_URL`/`AUTH_URL`/`NEXTAUTH_URL`, else the fixed production
  hostname), which **never trusts forwarded headers in production**.  An earlier cut of
  this branch derived the origin from `x-forwarded-host`; Codex review (#3124) correctly
  flagged that as an open redirect — those headers are client-influenceable at a
  directly reachable origin, so an unknown provider or a real `signIn()` failure could
  have aimed this PUBLIC route's `loginFallback` at an attacker's host.  Do not
  reintroduce header-derived origins here; a regression test asserts a spoofed
  `x-forwarded-host` still resolves to the canonical origin.

## Verification State

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; new vitest files 12/12 green;
  full `tsc → vitest → build` gate via `scripts/land.sh`.
- Swift compiles + XCTests on hosted `ios-build` (no local xcodebuild).
- Post-deploy live checks: the auth-start Set-Cookie for `__Secure-authjs.callback-url`
  must contain `/api/mobile/auth-redirect`; the authenticated snapshot's
  `performance.liveEquityCurve[0].date` must exist.

## Next Steps & Blockers

- After deploy, owner retest on-device: Google/GitHub should round-trip into the app;
  Apple sign-in should load the workspace (installed build, no update needed).
- Grok seat infra: both headless dispatch modes are dead (8317 refused / leader
  silent) — filed observation for the fleet; not this repo's scope.

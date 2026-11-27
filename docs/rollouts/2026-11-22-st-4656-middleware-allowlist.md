# ST-4656 exact public allowlist + legacy Apple auth telemetry (2026-11-22, Muse Code MC)

## Context & Objective
ST-4650 fleet-sweep auth batch: the middleware's public-prefix list failed open for any future route under `/api/ops`, `/api/webhooks`, or `/api/framework`, and legacy nonce-less Apple sign-ins were accepted with only a console warning, leaving no measurable basis for an eventual mandatory-nonce sunset.

## Changes Made
- `middleware.ts`: the three prefixes leave `PUBLIC_PREFIXES`; `EXACT_PUBLIC_PATHS` enumerates exactly today's nine self-gating routes (ops account-activity/account-control/fill-reconcile/hwm/recompute/performance/snapshot, webhooks congress/tradingview, framework/content), filesystem-enumerated — none of the three trees has a dynamic segment.  A trailing-slash spelling is admitted as the same route; bare prefixes and child paths now 401 unauthenticated (the intended fail-closed change).  Every handler keeps its own gate.
- `app/api/mobile/auth/apple/route.ts` + `src/lib/auth/mobile-session-hardening.ts`: after the server session record is created, an accepted non-strict (legacy) sign-in writes one best-effort `mobile_apple_legacy_auth_accepted` audit receipt (route/reason only, try/catch so it can never fail sign-in).  Strict accepts and all rejects write none; accept/reject paths are otherwise untouched.
- Tests: `test/middleware-auth.test.ts` (all 9 routes public with auth armed, trailing slash, synthetic future + bare prefix + child path 401), `test/apple-auth-route.test.ts` (legacy accept +1 receipt with no token material, strict +0, reject +0).

## Decisions & Trade-offs
- No nonce/sid enforcement flip: making strict mode mandatory needs an owner-chosen sunset date (and a shipped-build check), which the new telemetry now makes measurable.  The critic-refuted `trustedCloudflareClientIp` switch was not touched.
- OAuth legacy handoff keeps its existing warning only; receipts are Apple-scoped per the issue brief.
- Fail-closed cost is deliberate: a future route under these prefixes ships session-gated until listed here.

## Verification State
- Writer lane: middleware-auth 47/47, apple-auth-route 12/12, adjacent middleware/auth/ops suites 112/112; tsc + eslint clean of errors.
- Parent on harvested tree: full `npm run lint` 0 errors, `npx tsc --noEmit` clean, targeted vitest 13 files / 171 tests passed, `npm run build` exit 0.  Full serial suite runs in CI verify.

## Next Steps & Blockers
- Owner: pick the mandatory-nonce sunset date once legacy receipts read ~zero; that flip is a separate change.

## Zero-Code Findings
- None.

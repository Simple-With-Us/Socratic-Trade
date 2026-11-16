# Mobile auth exchange CSRF follow-up — 2026-07-22

## Summary

Kept `/api/mobile/auth/exchange` unauthenticated for the native client without bypassing the
middleware same-origin CSRF guard. Added a regression proving cross-site POSTs are rejected.

## Why

The prior middleware change placed the exchange route in `PUBLIC_PREFIXES`, causing an early return
before `checkSameOrigin`. That allowed a browser-signaled cross-site POST to reach the cookie-setting
route. The opaque one-time code and device verifier authorize the native handoff, but they do not
prove that the current browser intended to accept the login.

## Files

- `middleware.ts`
- `test/middleware-auth.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-07-22-mobile-auth-exchange-csrf.md`

## Verification

Completed locally on the final middleware shape:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/middleware-auth.test.ts \
  test/mobile-auth-handoff.test.ts \
  test/mobile-auth-exchange-route.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint middleware.ts test/middleware-auth.test.ts
```

The focused Vitest command passed 3 files / 34 tests; TypeScript and ESLint also passed. Hosted
`verify-hosted` is the required merge gate. Its initial run is queued at the time of this note; a
separate Security `gitleaks` run was canceled and re-queued. The unrelated `autofix` check failed
before PR code ran because its self-hosted runner did not have `unzip`, preventing Bun installation
(exit 127); that runner issue was escalated separately.

## Follow-ups

Corrected the duplicate/stale native iOS effort row in `docs/EFFORT-LOG.md`: #1886 is merged and
#1888 is the active middleware follow-up. No production native distribution is claimed; TestFlight/
App Store release remains separate.

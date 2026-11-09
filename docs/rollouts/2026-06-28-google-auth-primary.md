# 2026-06-28 - Google auth primary

## Summary

- Made Auth.js Google sessions the app's configured identity source.
- Stopped trusting Cloudflare Access email headers in middleware while keeping
  Cloudflare Tunnel-compatible public-origin handling.
- Changed `/logout` to clear Auth.js cookies and return to the app `/login`
  page instead of calling `/cdn-cgi/access/logout`.
- Changed empty `ALLOWED_EMAILS` from "defer to Cloudflare Access" to
  "allow only the primary operator and aliases."
- Updated auth tests and active docs to match the Google-auth contract.

## Why

The production site should stay reachable through the Cloudflare tunnel but use
Google login as the site auth layer. Keeping Cloudflare Access as a trusted
identity source made reconnect/login behavior dependent on the outer gateway and
kept reintroducing the old Access-owned session path.

## Files

- `middleware.ts`
- `app/login/page.tsx`
- `app/logout/route.ts`
- `src/lib/auth/identity.ts`
- `src/lib/request-user.ts`
- `.env.example`
- `test/middleware-auth.test.ts`
- `test/logout-route.test.ts`
- `test/auth-identity.test.ts`
- `docs/phase-11-multi-user.md`
- `docs/deployment.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-28-google-auth-primary.md`

## Verification

- `npx vitest run test/middleware-auth.test.ts test/logout-route.test.ts test/auth-identity.test.ts test/request-user.test.ts` - passed, 4 files / 26 tests.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 153 files / 1,488 tests.
- `npm run build` - passed; Next.js emitted the existing middleware-to-proxy deprecation warning.
- `bash scripts/land.sh` - passed; opened PR #219.
- GitHub PR checks - passed: `verify`, `smoke`, and `gitleaks`; PR #219 auto-merged.
- Production deploy run `28319030128` - passed; `/Users/jay/apps/trading-live` is at `6599290d`.
- Cloudflare Zero Trust root Access app `agentic-trading-dashboard`
  (`9539f646-575d-4e7c-b182-0bbe7c02083a`) now has bypass policy
  `42c4adc9-1421-416b-b744-f291afc87938` named
  `Bypass Cloudflare Access; app Google auth handles login`.
- Live public checks passed:
  - `https://socratictrade.com/` returns app `307 /login`, not a Cloudflare Access login.
  - `https://socratictrade.com/login` returns the app login page with `Sign in with Google`.
  - `https://socratictrade.com/api/auth/providers` returns the Google provider and callback URL.
  - `https://socratictrade.com/api/dashboard` returns app `401 Unauthorized`.
  - `https://socratictrade.com/logout` clears Auth.js cookies and redirects to app `/login`.
- 2026-06-29 follow-up after later production deploys:
  - Live public checks still pass: `/` reaches app `/login`, `/login` shows Google sign-in,
    `/api/auth/providers` exposes Google, and unauthenticated `/api/dashboard` returns app `401`.
  - Sanitized Infisical verification through `scripts/infisical-run.mjs` confirmed prod has
    `NEXT_PUBLIC_SITE_URL=https://socratictrade.com`, `AUTH_URL=https://socratictrade.com`,
    `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `PRIMARY_USER_EMAIL=<configured>`,
    `PRIMARY_USER_EMAIL_ALIASES=<configured>`, and `ALLOWED_EMAILS=<configured>`. Concrete account
    values were intentionally omitted from the public rollout note.
  - Removed the app-project `CF_ACCESS_TRUST_EMAIL_HEADER` secret, found the shared overlay still
    supplied `CF_ACCESS_TRUST_EMAIL_HEADER=1`, then set an app-project override to
    `CF_ACCESS_TRUST_EMAIL_HEADER=0`. Code ignores this variable now, but the override keeps stale
    branches from rearming Cloudflare Access-header trust if they read the old flag.

## Follow-ups

- Rollback for the Cloudflare-side change: delete bypass policy
  `42c4adc9-1421-416b-b744-f291afc87938` from Access app
  `9539f646-575d-4e7c-b182-0bbe7c02083a`.
- Rollback for the Infisical override: delete app-project
  `CF_ACCESS_TRUST_EMAIL_HEADER=0`; the shared overlay currently supplies `1`.

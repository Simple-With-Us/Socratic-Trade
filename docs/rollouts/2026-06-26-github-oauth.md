# 2026-06-26 — GitHub OAuth as alternative sign-in provider

## Summary

Added GitHub OAuth alongside Google OAuth so the login page is usable when only one
provider is configured. Before this change, a deployment with `AUTH_SECRET` set but no
Google credentials would show the login page with no way to sign in.

## Why

The login page showed "Auth provider not configured" (with no sign-in button) whenever
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` were missing — even if `AUTH_SECRET` was set,
arming the auth gate. Adding GitHub OAuth gives a second option that's equally easy to
provision and covers the common case where operators have GitHub but not a GCP project.

## Files

- `src/lib/auth/auth.ts` — conditionally registers Google and/or GitHub providers based
  on which env vars are present; `signIn` callback rejects GitHub sessions with no email.
- `app/login/page.tsx` — `export const dynamic = "force-dynamic"` added; renders sign-in
  buttons for whichever providers are configured; updated "no provider" hint.
- `.env.example` — documents `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` with setup instructions;
  updated `ALLOWED_EMAILS` comment to clarify CF vs Auth.js behavior.
- `middleware.ts` — `isEmailAllowed` now accepts `fromCf: boolean`; identity source tracked
  per request so CF-defer only fires when CF actually provided the header.
- `test/middleware-auth.test.ts` — added three new tests: primary user JWT (200), allowlisted
  non-primary JWT (200), non-primary non-allowlisted JWT (403), and dual-source regression
  (Auth.js session bypassing CF → 403 even when CF flag is on).
- `STATUS.md` — updated with GitHub OAuth feature and security fix status.
- `docs/rollouts/2026-06-26-github-oauth.md` — this file.

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1250/1250 passed
npm run build      # clean, /login compiled as static
```

## Security fix (Codex P1)

`middleware.ts` `isEmailAllowed` previously treated empty `ALLOWED_EMAILS` as
"allow all" (designed for CF Access, which enforces its own allowlist). With
Auth.js + GitHub, any GitHub account holder could sign in. Fixed: empty
`ALLOWED_EMAILS` now only defers to the upstream gateway when
`CF_ACCESS_TRUST_EMAIL_HEADER=1`; without CF Access, only `PRIMARY_USER_EMAIL`
(and its aliases) and explicitly listed `ALLOWED_EMAILS` are admitted.

Added a new test: `valid Auth.js JWT for non-primary non-allowlisted user → 403`.

## Static prerender fix (Codex P2)

`app/login/page.tsx` was prerendered as static HTML (`○`) at build time, so
`AUTH_GITHUB_*` checks were frozen at build time. Added `export const dynamic =
"force-dynamic"` — the page is now server-rendered (`ƒ`) and reads env vars at
request time, so secrets injected via Infisical after a build are immediately
reflected.

## Identity-source tracking fix (Codex P1 follow-up)

Second Codex P1 review found a subtler bug: when both `CF_ACCESS_TRUST_EMAIL_HEADER=1` and
`AUTH_SECRET` are set, a request that bypasses Cloudflare (no CF header) falls through to
the Auth.js cookie path. The old `isEmailAllowed` checked the CF *config flag* rather than
whether CF actually provided the identity for that request — so a non-primary OAuth user who
reached the origin directly would be admitted when `ALLOWED_EMAILS` was empty.

Fixed by:
1. Adding a `fromCf: boolean` parameter to `isEmailAllowed`.
2. Tracking identity source in `middleware()`: `fromCf = true` only when `getCfEmail()` returns
   a value (i.e. the CF header was present and trusted).
3. `isEmailAllowed` defers to CF's allowlist only when `fromCf === true`.

Added regression test: `Auth.js JWT for non-primary user → 403 even when CF_ACCESS flag is on`.

### Verification (post identity-source fix)

```
npx tsc --noEmit   # clean
npm test           # 1253/1253 passed
npm run build      # clean
```

## Operator notes

- Add `user@example.com`-style addresses to `ALLOWED_EMAILS` for any non-primary
  users who should have access (comma-separated).
- Production GitHub **OAuth App** (not a GitHub App, not Coolify App `4238447`):
  Homepage `https://socratictrade.com`.  Authorization callback URL
  `https://socratictrade.com/api/auth/callback/github`.
- `host.jays.services` is Coolify.  Do not use it as the Auth.js callback.
- Infisical: add `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` to the `agentic-trading`
  project when provisioning.

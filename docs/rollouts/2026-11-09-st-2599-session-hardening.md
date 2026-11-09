# 2026-11-09 — ST-2599: Server-backed sessions + mobile handoff hardening

## Context & Objective

ST-2599 replaces stateless 30-day Auth.js JWTs with revocable server session rows and tightens native sign-in handoff paths (PKCE nonce binding, Apple nonce, push token ownership).

## Changes Made

- Added `auth_sessions` SQLite table (migration v102) and Drizzle module `src/lib/db-auth-sessions.ts`.
- JWTs now carry `sid` + `absExp`; `decodeSessionToken` (Node) checks the DB; edge middleware uses crypto-only decode plus `absExp` for bounded sessions.
- Sign-out revokes the current server row; new `POST /api/auth/sessions/revoke-all` plus Settings UI "Sign out everywhere".
- Mobile: `POST /api/mobile/auth/handoff-prepare`, auth-redirect requires `handoff_nonce`; Apple sign-in requires server nonce; push register returns 409 when token belongs to another user.

### Files touched

- `src/lib/db/schema.ts`, `src/lib/db.ts`, `src/lib/db-auth-sessions.ts`
- `src/lib/auth/session-jwt-crypto.ts`, `session-token.ts`, `session-edge.ts`, `session-policy.ts`, `session-sign-out.ts`, `auth.ts`
- `src/lib/auth/apple-signin-nonce.ts`, `mobile-handoff-prepare.ts`, `src/lib/mobile-auth-handoff.ts`
- `app/logout/route.ts`, `app/api/auth/sessions/revoke-all/route.ts`
- `app/api/mobile/auth/handoff-prepare/route.ts`, `auth-redirect/route.ts`, `auth/apple/route.ts`, `auth/apple/nonce/route.ts`, `push/register/route.ts`
- `app/console/settings/page.tsx`
- `test/st-2599-auth-sessions.test.ts` and updates to apple/mobile/push tests

## Decisions & Trade-offs

- Edge middleware cannot open SQLite; it accepts **legacy** JWTs on `exp` only and **server-backed** JWTs on `absExp` (no `srvTouch` age gate). Revocation is enforced on Node via `auth_sessions` (middleware forwards `x-authenticated-session-sid`).
- Absolute session ceiling: 90 days from first sign-in; sliding cookie refresh capped at 30 days but never past `absExp`.
- Legacy JWTs without `sid` are backfilled into `auth_sessions` only on Auth.js JWT refresh (`jwt` callback), not on every `decodeSessionToken` (avoids orphan rows).
- Shipped iOS web OAuth legacy path accepts `handoff_nonce=__legacy_compat__` with a real `sid` in the cookie (PKCE-only compat).
- Shipped iOS builds without `handoff_nonce` / Apple server nonce use a logged legacy compat path until they send `x-socratic-mobile-session-hardening: 1` or the new fields (then enforcement is strict).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/st-2599-auth-sessions.test.ts test/mobile-auth-redirect-route.test.ts test/middleware-auth.test.ts test/apple-auth-route.test.ts test/apns-register-route.test.ts test/mobile-auth-handoff.test.ts
NODE_OPTIONS="--max-old-space-size=8192" npm run build
```

Build passes. Full `npm test` in this VM reported 33 failures in unrelated suites (env/network); targeted auth/session tests are green.

## Next Steps & Blockers

- Follow-ups (out of scope ST-2599): Cloudflare origin IP restriction, CSP enforcement, iOS Keychain/app lock.
- iOS clients must call `handoff-prepare` before OAuth and `GET /api/mobile/auth/apple/nonce` before native Apple sign-in.

## Zero-Code Findings

None.

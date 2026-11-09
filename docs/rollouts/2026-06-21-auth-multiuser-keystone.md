# 2026-06-21 — Auth / multi-user keystone (closes the IDOR)

## Summary
First slice of the multi-user build (Q3): establish a **trusted, non-spoofable identity** and close the
universal IDOR the design surfaced. Identity is derived from a VERIFIED email (Cloudflare Access today;
Google/Auth.js next), never from a client-supplied hint.

## Why
`docs/chat-multiuser-learning-design.md` §2 found there was **no auth**: `userId` came from a spoofable
`x-user-id` header / `?userId` / body (default `'local'`), so anyone past the gateway could read or
overwrite another user's encrypted API keys or place trades as them. The persistence layer is already
`WHERE user_id = ?`-scoped, so fixing identity at the edge closes the hole. The app is behind Cloudflare
Access (email allowlist + 24h OTP), so this is not publicly exploitable — but it is a real in-app
isolation bug and the prerequisite for multi-user.

## What changed
- **`middleware.ts` (NEW, edge):** runs on every non-static request. Resolves a trusted email from
  Cloudflare Access (`Cf-Access-Authenticated-User-Email`, gated on `CF_ACCESS_TRUST_EMAIL_HEADER=1`),
  checks the allowlist, and forwards `x-authenticated-user-email` while **stripping the spoofable
  `x-user-id`**. Fails closed in production (401 for `/api/*`, redirect to `/access-denied` for pages);
  dev/test falls back to the primary user. Crypto-free (edge-safe).
- **`src/lib/auth/identity.ts` (NEW, node):** `userIdForEmail` maps the **primary email → legacy `'local'`
  id** (so no data migration is needed) and every other email → a stable `u_<sha256>` id; `isEmailAllowed`
  / `isPrimaryEmail`. Allowlist via `ALLOWED_EMAILS` (empty = defer to the gateway).
- **`src/lib/request-user.ts` (rewrite):** `resolveRequestUserId` now trusts ONLY the middleware-set
  `x-authenticated-user-email`; the `x-user-id` / `?userId` / body `userId` vectors are gone. Signature
  kept `(request, _body?)` so the ~30 call sites are untouched. Dev/test fall back to `DEV_USER_ID`.
- **`app/access-denied/page.tsx` (NEW):** simple denied page for allowlisted-but-not-permitted users.
- **`.env.example`:** documents `CF_ACCESS_TRUST_EMAIL_HEADER`, `PRIMARY_USER_EMAIL`, `ALLOWED_EMAILS`,
  `DEV_USER_ID`, and the (next-slice) Auth.js/Google vars.
- **Tests:** `test/request-user.test.ts` rewritten to assert the secure behavior (trusts only the verified
  header; ignores `x-user-id`/`?userId`/body); `test/auth-identity.test.ts` (primary→`local`, isolated
  ids, allowlist).

## Files
- `middleware.ts`, `src/lib/auth/identity.ts`, `src/lib/request-user.ts`, `app/access-denied/page.tsx`,
  `.env.example`, `test/request-user.test.ts`, `test/auth-identity.test.ts`

## Verification
- `npx tsc --noEmit` clean; `npm test` **419 passed**; auth tests 6/6.
- Preview (dev): `/api/health`, `/`, `/api/dashboard` all 200 (dev fallback identity works; middleware
  doesn't break local dev). `npm run build` to be run by `scripts/land.sh` at land time.

## Follow-ups
- **To activate in prod:** set `CF_ACCESS_TRUST_EMAIL_HEADER=1` (+ optionally `ALLOWED_EMAILS`). Confirm
  CF Access is in front so the email header is trustworthy.
- **Next slice — Google sign-in (Auth.js v5):** needs an OAuth client (`AUTH_GOOGLE_ID/SECRET`,
  `AUTH_SECRET`) from the operator. Adds an in-app login independent of the gateway.
- **Then:** route-layer ownership assertions on `[id]` routes; per-user SSE filtering
  (`events/stream/route.ts`); frontend cleanup of the now-ignored `?userId=local` in
  `dashboard-client.tsx`/`settings.tsx`; per-user broker token (`mcp-oauth.ts`). Adversarial security
  review pending before merge.

# 2026-06-21 — Strip client identity headers on public routes (auth hardening)

## Summary

Defense-in-depth follow-up to the auth keystone (`8d2e9fa`). The edge `middleware.ts` PUBLIC_PREFIXES
branch (`/api/health`, `/api/webhooks`, `/access-denied`) forwarded the request **unchanged**
(`return NextResponse.next()`), so a client could send a forged `x-authenticated-user-email` /
`x-user-id` header to a public route and it would pass through. Those routes are correctly public —
external webhook senders and uptime probes can't pass Cloudflare Access — but they must still strip
client-supplied identity so a handler can never be handed a forged one.

## Why

Not exploitable today (the webhook/health handlers don't call `resolveRequestUserId`), but a latent
footgun: any future public route that reads identity would trust the spoofed value. Closing it now
keeps the "identity is only ever set by verified middleware" invariant total. The public routes stay
fully unauthenticated — webhook delivery is unaffected.

## What changed

- **`src/lib/auth/strip-identity.ts` (new, edge-safe):** `CLIENT_IDENTITY_HEADERS` +
  `stripClientIdentityHeaders(headers)` — removes `x-authenticated-user-email` and `x-user-id`.
- **`middleware.ts`:** the PUBLIC branch now strips identity headers before forwarding
  (`NextResponse.next({ request: { headers } })`); the authenticated branch uses the same helper, then
  sets the VERIFIED email (previously it only `.delete`d `x-user-id` and relied on `.set` overwriting).
- **`test/strip-identity.test.ts` (new):** strips both identity headers, leaves others intact, no-op
  when absent, and pins the exact header set.

## Verification

Built in an isolated worktree `~/apps/trading-strip` off clean `origin/main` (`842c2a6`), shared
`node_modules`.

- `npx tsc --noEmit` — clean.
- `npm test` — **459 passed** (59 files), incl. new `test/strip-identity.test.ts` (3).
- `npm run build` — succeeded (Middleware compiled).

## Notes

- The other auth hardening flag (CF-Access trust depends on `CF_ACCESS_TRUST_EMAIL_HEADER=1` only being
  set when genuinely behind Cloudflare Access) is a deployment-config concern, documented in
  `middleware.ts`, not a code change.
- The auth slice itself (`middleware.ts`, `src/lib/auth/identity.ts`, the `resolveRequestUserId`
  rewrite) already landed on `main` — this only hardens the public-route branch.

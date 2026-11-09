# 2026-06-21 — CSRF origin guard + per-user rate limiting + admin-role gate

Branch: `feat/csrf-rate-limit-admin` (isolated worktree off `main`).

## Summary

Implemented the SECURITY-HARDENING gap "CSRF + rate-limit + admin-role". Three independent,
composable pieces, all edge-safe where they run in middleware:

1. **CSRF (same-origin) guard** — `src/lib/auth/csrf.ts` (`checkSameOrigin`), wired into
   `middleware.ts`. Rejects state-changing (`POST/PUT/PATCH/DELETE`) `/api/*` requests that a
   browser signals as cross-site. Uses `Sec-Fetch-Site` first (browser-set, unforgeable by page
   JS), falling back to `Origin`/`Referer` host matching (honoring `x-forwarded-host` for the
   tunnel). Fail-open for non-browser callers (no Origin/Sec-Fetch-Site → server-to-server, curl,
   webhook senders); fail-closed only on a proven cross-origin browser request. Runs AFTER the
   `PUBLIC_PREFIXES` early-return, so `/api/health` and `/api/webhooks` (own shared-secret auth) are
   unaffected. Chosen over a token-cookie scheme because the app uses header-based identity.

2. **Per-user rate limiter** — `src/lib/rate-limit.ts`. In-process sliding-window, no new deps.
   Keyed by `userId:route`. Fail-OPEN on internal limiter error, fail-CLOSED (429 + `Retry-After`)
   when over limit. Applied to sensitive routes:
   - `app/api/auth/robinhood/start` (OAuth start) — `RATE_LIMITS.oauth` (10/min)
   - `app/api/auth/robinhood/callback` (OAuth callback, keyed by resolved-id + client IP) — oauth
   - `app/api/orders/cancel` — `RATE_LIMITS.orders` (20/min)
   - `app/api/proposals/[id]/approve` (order placement via `executeProposal`) — orders

3. **Admin-role gate** — `src/lib/auth/admin.ts` (`requireAdmin`/`checkAdmin`/`isAdminEmail`).
   Gates on the trusted `x-authenticated-user-email` against an `ADMIN_USER_EMAILS` allowlist
   (comma-separated) plus the primary operator; **default-deny in production when unset**. Composes
   with (does not regress) the existing gate: still accepts the legacy `x-admin-token ===
   ADMIN_REINDEX_TOKEN` and runs open outside production. Wired into all six admin routes
   (`app/api/admin/*`), replacing each route's local `authorized()` token-only helper.

## Why

Header-based identity means the browser attaches the user's ambient identity to any same-site
request — the classic CSRF vector — so a same-origin assertion is the right guard. Sensitive
auth/order routes needed abuse containment without a new dependency. Admin/dev diagnostic routes
previously gated only on a shared token or "not production"; an email allowlist gives a real
admin-role concept that fails closed in prod.

## Files

- Added: `src/lib/auth/csrf.ts`, `src/lib/rate-limit.ts`, `src/lib/auth/admin.ts`
- Added tests: `test/csrf.test.ts`, `test/rate-limit.test.ts`, `test/admin-gate.test.ts`
- Edited: `middleware.ts` (CSRF wiring)
- Edited (rate limit): `app/api/auth/robinhood/start/route.ts`,
  `app/api/auth/robinhood/callback/route.ts`, `app/api/orders/cancel/route.ts`,
  `app/api/proposals/[id]/approve/route.ts`
- Edited (admin gate): `app/api/admin/backtest-ic/route.ts`, `app/api/admin/emit-test/route.ts`,
  `app/api/admin/refresh-websource/route.ts`, `app/api/admin/reindex-8k/route.ts`,
  `app/api/admin/robinhood-probe/route.ts`, `app/api/admin/trigger-test/route.ts`
- Docs: this note, `STATUS.md`

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 76 files / 642 tests pass (+19 new: CSRF 9, rate-limit 4, admin 6).
- `npm run build` — succeeds; Middleware bundle builds with the CSRF import.

## Follow-ups / risks

- The rate limiter is single-process (the deployment is a single `next start`). If the app ever
  scales horizontally, swap the in-memory store for a shared one (Redis/Upstash) — the
  `rateLimit()` surface stays the same.
- `ADMIN_USER_EMAILS` must be set in production for any non-primary admin; document in
  `.env.example` when convenient.
- CSRF guard is intentionally fail-open for callers with no browser-origin signal; identity/auth is
  still enforced separately by the existing middleware identity gate.

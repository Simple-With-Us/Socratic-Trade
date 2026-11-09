# 2026-06-23 - Multi-user auth, account UI, and production hardening

## Summary

Integrated the Auth.js/Cloudflare Access identity branch onto current `origin/main`
and fixed the account UI issues found during the expert/site pass.

## Why

Production needs multi-user identity without leaking the primary `local` account,
and the account cockpit needs to make active-account state, logout, and Test/Paper/
Brokerage risk obvious. The user also found two concrete bugs: the account selector
could still display Test after activating Alpaca Paper, and Alpaca MCP positions
could display `0 sh` when the upstream response used `quantity` instead of `qty`.

## Files

- `.env.example`
- `app/api/auth/[...nextauth]/route.ts`
- `app/api/dashboard/route.ts`
- `app/api/keys/route.ts`
- `app/dashboard-client.tsx`
- `app/dashboard-types.ts`
- `app/login/page.tsx`
- `app/logout/route.ts`
- `app/page.tsx`
- `middleware.ts`
- `package.json`
- `package-lock.json`
- `src/lib/alpaca.ts`
- `src/lib/auth/auth.ts`
- `src/lib/auth/session-edge.ts`
- `src/lib/auth/session-token.ts`
- `src/lib/dashboard.ts`
- `src/lib/request-user.ts`
- `test/alpaca-mcp.test.ts`
- `test/middleware-auth.test.ts`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-22-auth-m6.md`
- `docs/rollouts/2026-06-23-multi-user-auth-account-ui.md`
- `PLAN.md`
- `STATUS.md`

## Changes

- Added Auth.js v5 Google sign-in routes and login page while keeping Cloudflare
  Access as the preferred trusted identity source.
- Reworked middleware to fail closed whenever `CF_ACCESS_TRUST_EMAIL_HEADER=1` or
  `AUTH_SECRET` is set, while preserving the local development fallback when auth
  is unarmed.
- Configured Auth.js to write a compact HS256 session JWT and shared that
  encode/decode helper with middleware. This keeps session cookies verifiable in
  the edge runtime without the old `jose/jwt/verify` missing-subpath build error
  or the broad `next-auth/jwt` / `jose` compression warning.
- Added `/logout`, visible signed-in email, a header logout icon, and a command
  palette Sign out action.
- Made server-rendered dashboard data request-scoped by deriving the user from
  middleware's trusted email header before calling `getDashboardSnapshot`.
- Added `currentUser` metadata to dashboard snapshots for UI display.
- Fixed the account selector to use the derived execution account ID and to reload
  after activation errors/successes through one shared path.
- Added a row-level Use action in Accounts so switching accounts is explicit.
- Updated the top execution banner to use a bold account type plus italic details:
  Test Account, Alpaca Paper Account, and other broker accounts follow the same
  visual grammar.
- Updated the Alpaca connection form to state the two default endpoints:
  `https://paper-api.alpaca.markets/v2` and `https://api.alpaca.markets/v2`.
  The custom endpoint URL field is now hidden unless the user enables it.
- Removed the stale `userId: "local"` API-key save payload and changed key badges
  to "Your key" vs "Operator env".
- Changed shared-data consent copy to say private account data is server-side
  private and never shared with other users, instead of "never leaves your device".
- Fixed Alpaca MCP position parsing to accept both `qty` and `quantity`, preserving
  fractional positions such as `0.5` AAPL shares.

## Verification

- `npx tsc --noEmit` - passed.
- `npx vitest run test/alpaca-mcp.test.ts test/middleware-auth.test.ts test/request-user.test.ts test/dashboard-feed.test.ts --testTimeout=20000` - passed, 4 files / 31 tests.
- `npm test` - passed, 99 files / 908 tests.
- `npm run build` - passed, compiled successfully with no edge-runtime warnings.
- `git diff --check` - passed.
- `pm2 restart trading-codex --update-env` - passed; process online.
- `curl -s -I http://127.0.0.1:4101/api/health` - 200 OK.
- `curl -s -I -H 'cf-access-authenticated-user-email: jaywedgeworth22@gmail.com' http://127.0.0.1:4101/` - 200 OK.
- `curl -s -I https://codex.jays.services/api/health` - 302 to Cloudflare Access.

## Follow-ups

- Replace the live-order `window.prompt` approval with an in-app ticket modal.
- Add command-palette disabled states/reasons for blocked actions.
- Continue the remaining per-user data-isolation audit for any future learning or
  materialization tables.

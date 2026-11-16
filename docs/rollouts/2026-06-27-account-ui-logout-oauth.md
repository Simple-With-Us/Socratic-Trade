# 2026-06-27 - Account UI polish + logout/OAuth reconnect hardening

## Summary

- Shortened the Robinhood reconnect warning in Settings -> Accounts to
  `Robinhood needs to be reconnected.`
- Added a `Manage Accounts` action in the Settings modal header, beside the
  close button.
- Made the command-bar account selector's `Manage Accounts...` option italic.
- Matched command-bar Mode/Account selector typography and widened Mode so
  `Autonomous Mode` is not truncated.
- Fixed `/logout` to build Cloudflare Access logout URLs from the public app
  origin instead of internal localhost.
- Hardened Robinhood OAuth reconnect so callback completion preserves the
  initiating public redirect/client, and dynamic client registration wins over
  any stale static client id when configured.

## Why

Production showed two user-facing confusion points after the earlier account
readiness/OAuth fixes: the UI exposed low-level MCP token detail where a concise
reconnect instruction was enough, and sign-out/reconnect flows could still leak
localhost into externally visible OAuth/logout URLs. The reconnect flow also
needed to avoid replacing the public callback client with a localhost callback
client during the provider callback.

## Files

- `.env.example`
- `README.md`
- `PLAN.md`
- `STATUS.md`
- `app/dashboard-client.tsx`
- `app/logout/route.ts`
- `app/ui/overlays.tsx`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-27-account-ui-logout-oauth.md`
- `src/lib/mcp-oauth.ts`
- `src/lib/public-origin.ts`
- `test/logout-route.test.ts`
- `test/mcp-oauth.test.ts`

## Verification

- `npm ci` - passed
- `npm test -- --run test/mcp-oauth.test.ts test/logout-route.test.ts` - passed
- `npx tsc --noEmit` - passed
- `npm test` - passed (1467/1467)
- `npm run build` - passed
- `npm run lint` - passed (0 errors / 214 existing warnings)

## Follow-ups

- After this lands, verify `https://socratictrade.com/logout` redirects
  through `https://socratictrade.com/cdn-cgi/access/logout?...`, not
  `https://localhost:4000/...`.
- Re-test Robinhood reconnect on production after deploy. If Robinhood still
  returns `/oauth/error`, inspect the provider-side registration/client policy
  next; the app should now be sending a public callback/client consistently.

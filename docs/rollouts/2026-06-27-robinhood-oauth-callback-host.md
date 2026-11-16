# 2026-06-27 - Robinhood OAuth callback host fix

## Summary

Fixed the Robinhood OAuth production callback path so hosted flows do not send
the provider back to `localhost:4000` and do not stop at a blank `Unauthorized`
middleware response.

## Why

Production runs behind the public `socratictrade.com` tunnel while the Node
process listens on localhost. The OAuth start flow trusted a configured
loopback `ROBINHOOD_MCP_REDIRECT_URI`, and `/api/auth/robinhood/callback` was
not on the middleware public allowlist. That combination could produce exactly
the reported URL:

```text
http://localhost:4000/api/auth/robinhood/callback?code=...&state=...
```

The callback should be reachable by the OAuth provider without app-session
identity headers, but completion must still be state-bound.

## Changes

- OAuth start now resolves the callback URL from request forwarding headers,
  `NEXT_PUBLIC_SITE_URL`/Auth URL config, or the documented production origin
  when the configured redirect URI is loopback.
- Robinhood OAuth callback is public in middleware, but forged
  `x-authenticated-user-email`/`x-user-id` hints are still stripped.
- Callback completion cross-checks the verified app user when middleware
  provides one; otherwise it binds by the one-time server-side OAuth state row.
- Callback success redirects to the public app origin instead of whatever
  internal localhost URL reached the Node process.
- Dynamic OAuth client registration now re-registers when the callback redirect
  changes, so a client registered with a loopback redirect is not reused for the
  hosted callback.
- `.env.example` and README now document leaving
  `ROBINHOOD_MCP_REDIRECT_URI` blank in hosted environments.

## Files

- `.env.example`
- `README.md`
- `STATUS.md`
- `PLAN.md`
- `app/api/auth/robinhood/callback/route.ts`
- `app/api/auth/robinhood/start/route.ts`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-27-robinhood-oauth-callback-host.md`
- `middleware.ts`
- `src/lib/mcp-oauth.ts`
- `test/mcp-oauth.test.ts`
- `test/middleware-auth.test.ts`
- `test/robinhood-tenant-isolation.test.ts`

## Verification

- `npm install` - completed in this fresh worktree; npm reported 2 moderate
  audit findings and pending install-script approvals, with no verification
  blocker.
- `npm test -- test/mcp-oauth.test.ts test/middleware-auth.test.ts test/robinhood-tenant-isolation.test.ts` - 3 files / 33 tests passed.
- `npx tsc --noEmit` - passed.
- `npm test` - 151 files / 1457 tests passed.
- `npm run build` - passed. Next.js emitted the existing middleware-to-proxy
  deprecation warning.
- `npm run lint` - passed with 0 errors / 218 existing warnings.

## Follow-ups

- After this lands and deploys, reconnect Robinhood from production Accounts.
  `/api/broker/mcp/health` should then report an authenticated MCP session and
  the Robinhood Agentic account should be able to refresh its cash balance.
- If production secrets still contain a loopback `ROBINHOOD_MCP_REDIRECT_URI`,
  the code now overrides it for hosted flows, but the cleaner secret-store state
  is to leave it blank or set it to
  `https://socratictrade.com/api/auth/robinhood/callback`.

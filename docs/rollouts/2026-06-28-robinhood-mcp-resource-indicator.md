# 2026-06-28 - Robinhood MCP OAuth resource indicator

## Summary

- Added `ROBINHOOD_MCP_RESOURCE` support for Robinhood MCP OAuth.
- OAuth authorization URLs now include the MCP `resource` indicator.
- Authorization-code and refresh-token exchanges now include the same `resource` body parameter.
- Kept the existing hosted/public callback behavior; this is not a localhost callback rollback.

## Why

- Production reconnect still landed on `robinhood.com/oauth/error` after clearing stale OAuth client/state rows.
- Live config already has `ROBINHOOD_MCP_REDIRECT_URI=https://socratictrade.com/api/auth/robinhood/callback`, dynamic registration enabled, and no static client id.
- Live DB showed a freshly registered dynamic client and pending state for the public callback, so the failure was no longer stale loopback callback handling.
- Robinhood MCP OAuth requires the protected resource indicator so the authorization server can bind the grant to `https://agent.robinhood.com/mcp/trading`.

## Files

- `.env.example`
- `README.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-28-robinhood-mcp-resource-indicator.md`
- `src/lib/mcp-oauth.ts`
- `test/mcp-oauth.test.ts`

## Verification

- Inspected production Infisical via `scripts/infisical-run.mjs` without printing secret values: dynamic registration is set, static client id/secret are empty, and public redirect is set.
- Inspected live SQLite OAuth rows: cached dynamic client + pending state both used `https://socratictrade.com/api/auth/robinhood/callback`.
- `npx vitest run test/mcp-oauth.test.ts` (13 passed)
- `npx tsc --noEmit`
- `npm test` (153 files / 1486 tests passed)
- `npm run build`

## Follow-ups

- Deploy this patch to production, restart `trading`, clear the current failed Robinhood MCP OAuth client/state rows, then retry reconnect from `socratictrade.com`.

# 2026-07-24 - Robinhood MCP Production Redirect URI & Dynamic Client Refresh Fix

## Context & Objective

1. When attempting to reconnect Robinhood from `socratictrade.com`, the browser initially redirected to `http://localhost:4000/api/auth/robinhood/callback?code=...&state=...`, resulting in Safari error "Safari Can't Connect to the Server 'localhost'".
2. After updating Infisical secrets, Robinhood displayed "Uh oh! Something's gone wrong / An unexpected error occurred while connecting this application to Robinhood" on `robinhood.com/oauth`. This was caused by the application reusing a stale/expired dynamic `client_id` previously stored in SQLite `settings` table (`robinhood_mcp_oauth_client`).

## Changes Made

- **Infisical Production Secrets**:
  - `ROBINHOOD_MCP_REDIRECT_URI` updated to `https://socratictrade.com/api/auth/robinhood/callback` (previously set to `http://localhost:4000/api/auth/robinhood/callback`).
  - `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT` updated to `off`.
- **Dynamic OAuth Client Refresh (`src/lib/mcp-oauth.ts`)**:
  - Updated `buildMcpAuthorizationUrl` and `getOrRegisterClient` to pass `{ forceRegister: true }` when initiating an OAuth authorization flow. This guarantees a fresh, active dynamic `client_id` is registered with Robinhood's OAuth server (`https://agent.robinhood.com/oauth/trading/register`) whenever a user clicks "Reconnect", preventing stale client ID rejection errors on `robinhood.com`.

## Decisions & Trade-offs

- Disabling loopback override in `prod` ensures public production users are always redirected back to `https://socratictrade.com/api/auth/robinhood/callback`.

## Verification State

- Tested Robinhood discovery & dynamic client registration: HTTP 200 with fresh `client_id`.
- Tested `https://robinhood.com/oauth` with freshly registered `client_id`: returns HTTP 200 HTML page without any "Something's gone wrong" error.
- Ran `npx tsc --noEmit` - passed cleanly.
- Ran `npm test -- test/mcp-oauth.test.ts` - 26 tests passed.

# 2026-06-28 - Robinhood MCP OAuth discovery

## Summary

- Robinhood OAuth start now follows the documented Trading MCP link first.
- When `ROBINHOOD_MCP_URL=https://agent.robinhood.com/mcp/trading`, the app
  discovers OAuth protected-resource and authorization-server metadata from the
  MCP auth challenge.
- Discovered authorization, token, and dynamic-registration endpoints take
  precedence over manual `ROBINHOOD_MCP_AUTHORIZATION_URL`,
  `ROBINHOOD_MCP_TOKEN_URL`, and `ROBINHOOD_MCP_CLIENT_REGISTRATION_URL`.
- Manual endpoint env remains supported for custom providers and can be forced
  with `ROBINHOOD_MCP_OAUTH_DISCOVERY=off`.

## Why

Robinhood's current Agentic Trading instructions tell supported clients to add
the Robinhood Trading MCP link, `https://agent.robinhood.com/mcp/trading`, and
authenticate from that MCP connection. They do not instruct users to manually
configure `https://robinhood.com/oauth` as an app-level OAuth URL. The reconnect
implementation should therefore treat the MCP link as the source of truth and
use manual OAuth endpoint env only as a fallback/custom-provider path.

## Files

- `src/lib/mcp-oauth.ts`
- `test/mcp-oauth.test.ts`
- `.env.example`
- `README.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-28-robinhood-mcp-oauth-discovery.md`

## Verification

- `npx vitest run test/mcp-oauth.test.ts test/robinhood-tenant-isolation.test.ts`
  - 2 files / 22 tests passed.
- `npx tsc --noEmit`
  - Passed.
- `npm test`
  - 153 files / 1,487 tests passed.
- `npm run build`
  - Passed.

## Follow-ups

- After deploy, clear the cached `robinhood_mcp_oauth_client` and pending
  `robinhood_mcp_oauth_state:%` rows before another production reconnect test.
- If Robinhood still returns `/oauth/error`, capture the browser authorization
  URL parameters and provider-side error context; the app will then be following
  the documented MCP-first discovery path.

# Rollout: per-user Robinhood OAuth token

_Date: 2026-06-21 · Branch: feat/per-user-broker-token_

## Summary

Scoped the Robinhood MCP OAuth token from a single process-global key to a
per-user key in the `settings` table.  Every `getMcpAccessToken`, `setMcpOAuthTokens`,
and `clearMcpOAuthTokens` call now requires a `userId` string.  The OAuth start
and callback routes, the MCP health route, and the admin probe route all resolve
the authenticated `userId` from the request before delegating.

## Why

The settings table previously stored a single `robinhood_mcp_oauth_tokens` key
shared across all users.  In a multi-user deployment, the last user to complete
OAuth would overwrite everyone else's token; a 401 from the MCP endpoint would
clear the global token, logging out all users simultaneously.  This change closes
those cross-user token exposure vectors while keeping the single-operator
`ROBINHOOD_MCP_AUTH_TOKEN` env-var path fully intact.

## Decisions applied (verbatim from owner)

1. **State-recovery at callback**: scan `settings WHERE key LIKE
   'robinhood_mcp_oauth_state:%:<randomPart>'` to recover the userId.
   Implemented via `findInternalSettingByKeyLike` in `db.ts` and
   `findMcpOAuthStateByRandom` in `mcp-oauth.ts`.  The random part has 32 bytes
   of entropy; collisions are not a realistic concern.

2. **CLIENT registration stays GLOBAL**: `CLIENT_SETTING =
   "robinhood_mcp_oauth_client"` is unchanged.  One OAuth app client is shared
   across all users; only TOKEN and STATE keys are per-user.

3. **`ROBINHOOD_MCP_AUTH_TOKEN` env var stays as a process-level operator
   override** that bypasses per-user lookup.  In multi-user production
   deployments this env var must NOT be set (it routes all users to the same
   token regardless of their individual OAuth state).  Documented in JSDoc on
   `getMcpAccessToken`.

4. **Auth/identity already shipped**: `middleware.ts`, `identity.ts`, and
   `resolveRequestUserId` are all live.  The start/callback/health routes now
   call `resolveRequestUserId(request)` and thread userId through.

## Files touched

| File | Change |
|---|---|
| `src/lib/db.ts` | Add `findInternalSettingByKeyLike` — LIKE-based single-row settings scan |
| `src/lib/mcp-oauth.ts` | Per-user key builders (`tokenSettingKey`, `stateSettingKey`); `userId` field on `McpOAuthState`; all token helpers accept userId; `findMcpOAuthStateByRandom` for callback state recovery |
| `src/lib/robinhood.ts` | `getRobinhoodGateway(userId)`, `getRobinhoodMcpHealth(userId)`, `callRobinhoodMcpTool(userId, ...)`, `callRobinhoodMcpMethod(userId, ...)` all accept userId; `HttpMcpRobinhoodGateway` stores userId; `fetchRobinhoodHistoricals`/`fetchRobinhoodFundamentals` accept optional userId defaulting to `DEV_USER_ID` |
| `src/lib/broker.ts` | Forward userId to `getRobinhoodGateway(userId)` |
| `app/api/auth/robinhood/start/route.ts` | `GET(request: NextRequest)` — resolves userId, passes to `buildMcpAuthorizationUrl(userId)` |
| `app/api/auth/robinhood/callback/route.ts` | No route-level changes needed — `completeMcpOAuthCallback` internally recovers userId via state scan |
| `app/api/auth/robinhood/tokens/route.ts` | NEW: `DELETE` — disconnect calling user's Robinhood OAuth token |
| `app/api/broker/mcp/health/route.ts` | `GET(request: NextRequest)` — resolves userId, passes to `getRobinhoodMcpHealth(userId)` |
| `app/api/admin/robinhood-probe/route.ts` | Resolves userId; passes to `callRobinhoodMcpTool(userId, ...)` |
| `app/api/connected-accounts/route.ts` | `getRobinhoodGateway(userId)` instead of no-arg call |
| `test/mcp-oauth.test.ts` | Updated existing test + 4 new tests (per-user state key, token isolation, env-var global override, selective clear) |
| `test/robinhood-mcp.test.ts` | Updated call sites to pass userId |

## State-recovery approach chosen

Approach (a): DB LIKE scan.  `findInternalSettingByKeyLike` runs one
`SELECT key, value FROM settings WHERE key LIKE ? LIMIT 1` per OAuth callback.
OAuth completions are rare (low volume); the 32-byte random suffix makes false
matches practically impossible.  The state blob is deleted immediately after use
to prevent replay.

## Verification commands run

```
npx tsc --noEmit   # 0 errors
npm test           # 71 test files, 597 tests — all pass
```

`npm run build` not run in this worktree (isolated agent lane per AGENTS.md
conventions; tsc + tests are the authoritative gate here).

## Follow-ups / deferred

- TTL sweep for orphaned state blobs (from abandoned OAuth flows) is tracked as
  a risk in the design doc but deferred; low impact at current volume.
- `fetchRobinhoodHistoricals` / `fetchRobinhoodFundamentals` callers in
  `history.ts` and `data-providers.ts` pass the default `DEV_USER_ID` (or rely
  on the `ROBINHOOD_MCP_AUTH_TOKEN` env override).  These pipeline callers can be
  updated to pass a real userId if/when those call sites get per-request context.
- The UI disconnect button (calling `DELETE /api/auth/robinhood/tokens`) and
  any settings-page wiring is a minor frontend follow-up; the route is wired.

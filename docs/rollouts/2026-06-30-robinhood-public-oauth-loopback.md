# 2026-06-30 - Robinhood MCP public reconnect loopback opt-in

## Summary

- Diagnosed the current public-domain Robinhood MCP reconnect path.
- Added `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=on`, an explicit opt-in that lets a public-site reconnect honor a configured localhost Robinhood callback.
- Updated Robinhood MCP docs/env examples, including the official `internal` scope.

## Why

`https://socratictrade.com/api/auth/robinhood/start` already returns a valid Robinhood authorize redirect with the public callback, PKCE, `internal` scope, and `https://agent.robinhood.com/mcp/trading` resource. Robinhood serves the pre-login OAuth page for that exact URL. Live pending state rows show public starts are created under `local` but do not complete, so the remaining failure is in Robinhood's logged-in consent leg or its return to the public callback, not in app login, tenant mapping, or token persistence.

The successful localhost path persists because the token is stored server-side under `local`; once the token exists, `socratictrade.com` can read it for the same app user. This change preserves public app login while allowing Robinhood's provider callback to use localhost on the same machine when the public callback is rejected.

## Files

- `.env.example`
- `README.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-30-robinhood-public-oauth-loopback.md`
- `src/lib/mcp-oauth.ts`
- `test/mcp-oauth.test.ts`

## Verification

- Live diagnostic: minted a short-lived Auth.js session cookie from production secrets, requested `https://socratictrade.com/api/auth/robinhood/start`, and confirmed HTTP 307 to `https://robinhood.com/oauth` with public callback, `internal` scope, PKCE, and MCP resource. Temporary state row was deleted.
- Live diagnostic: fetched the exact Robinhood authorize URL without login and confirmed HTTP 200 HTML with no `/oauth/error` or "something went wrong" page.
- Live DB inspection: one older pending state row remains under `local` with public callback, consistent with a prior public start that did not complete.
- `npm test -- test/mcp-oauth.test.ts` - 1 file / 16 tests passed.
- `npm run lint` - passed with 0 errors / 254 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - 165 files / 1,578 tests passed.
- `npm run build` - passed on the final merged base with the repo's webpack build path. Earlier build attempts exposed two host/worktree issues: Turbopack rejected the temporary symlinked `node_modules`, then the real copied dependency tree hit host `ENOSPC`; after merging the production build hotfix, clearing `.next`, and using webpack with the symlinked dependency tree, the build passed.

## Follow-ups

- After deployment, set `ROBINHOOD_MCP_REDIRECT_URI=http://localhost:4000/api/auth/robinhood/callback` and `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=on` in production secrets, restart `trading`, clear stale pending Robinhood OAuth state rows, then retry Reconnect from `https://socratictrade.com`.

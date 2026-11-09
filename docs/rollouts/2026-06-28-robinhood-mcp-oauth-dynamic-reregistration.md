# Rollout Note: Robinhood MCP OAuth Dynamic Re-registration on Hostname Change

## Summary
- Diagnosed the root cause of the `robinhood.com/oauth/error` ("Uh oh! Something's gone wrong") page encountered during user account connection/re-authorization when switching between different preview hostnames (e.g. `socratictrade.com`, `trading-beta.jays.services`, `antigravity.jays.services`).
- Fixed `getOrRegisterClient` in `src/lib/mcp-oauth.ts` to store and validate the `redirectUri` that the dynamic client registration was created for. If the requested `redirectUri` differs from the registered one (such as when switching preview worktrees or hostnames), it dynamically registers a new client ID at the registration endpoint.
- Added a unit test verifying dynamic re-registration is triggered when `redirectUri` changes.

## Why
- **OAuth Mismatch:** The dynamically registered client is registered at the broker console with exactly one redirect URI. When the app is accessed via a different domain, it constructs the OAuth authorize request using the cached dynamic client ID but the current domain's callback URL. Robinhood's authorization endpoint rejects the request due to the mismatch.
- **Auto-recovery:** Automatically registering a new client ID when `redirectUri` changes allows the connection flow to succeed immediately across different worktree previews and staging domains.

## Files
- **Touch**: [src/lib/mcp-oauth.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/src/lib/mcp-oauth.ts) (validate cached client `redirectUri` and store `redirectUri` on registration)
- **Touch**: [test/mcp-oauth.test.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/test/mcp-oauth.test.ts) (added `re-registers client dynamically if redirectUri changes` unit test)

## Verification
- Rebuilt native node modules (`npm rebuild`) to resolve compilation differences for Node 24.
- Ran verification checks:
  1. `npx tsc --noEmit` - passed cleanly
  2. `npm test` - all 1446 tests passed cleanly (including the new client re-registration test)
  3. `npm run build` - compiled Next.js output and generated static/dynamic routing without errors

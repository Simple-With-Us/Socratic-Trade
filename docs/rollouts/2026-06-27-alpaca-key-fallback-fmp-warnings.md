# Rollout Note: Alpaca API Key Fallback Resolution & FMP Warnings Fix

## Summary
- Checked the `/admin/connections` health status page and diagnosed completeness of instrumented sources.
- Fixed `resolveAlpacaMarketData` to fallback to decrypting valid credentials from the user's `connected_accounts` table, resolving persistent `HTTP 401` auth errors on the `alpaca-news` and `alpaca-snapshot` data enrichment providers.
- Fixed `FmpEnrichmentProvider` to disable health logging on optional/premium endpoints (`insider-trading`, `senate-trading`, `price-target-consensus`) returning `HTTP 403` on standard plans, preventing false-positive yellow warning dots on the dashboard.

## Why
- **Completeness:** The health page dynamically lists services based on the `api_health_log` table, meaning uncalled or uninstrumented services (like FRED, SEC XBRL scraper, and Alpaca execution) are naturally omitted.
- **Alpaca 401s:** Stored keys in `user_api_keys` (migrated from env) were invalid/expired, whereas correct keys existed in `connected_accounts`.
- **FMP Yellow Dot:** Premium endpoints were unconditionally called and written as service failures on standard subscription tiers.

## Files
- **Touch**: [src/lib/db-api-keys.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/src/lib/db-api-keys.ts) (modified `resolveAlpacaMarketData` key lookup hierarchy)
- **Touch**: [src/lib/data-providers.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/src/lib/data-providers.ts) (modified FMP `getJson` signature and disabled health logging on premium queries)
- **Touch**: [test/key-resolution-tiering.test.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/test/key-resolution-tiering.test.ts) (added tests verifying connected accounts credentials resolution and preference)

## Verification
The following commands were run in the worktree root:
1. `npx tsc --noEmit` - passed cleanly
2. `npm test` - all 1255 tests passed cleanly (including the new credential-resolution tests)
3. `npm run build` - compiled Next.js output and generated static/dynamic routing without errors

## 2026-06-30 PR #237 Review Follow-up

### Summary
- Resolved the remaining PR review blocker by extending `resolveAlpacaMarketData` to use the operator/local connected Alpaca account as the shared read-only fallback for no-user/background scans and tenants without complete Alpaca market-data credentials.
- Required connected-account and stored-user Alpaca market-data credentials to include both key and secret before they suppress the operator fallback, preserving the real-time snapshot tier when a tenant only has an OAuth/API-key-only row.
- Preserved key-only tenant Alpaca credentials as the final user fallback when no complete shared/operator credential exists, so the Alpaca news tier can still use bearer-token auth.
- Scanned ranked alternate connected Alpaca accounts before falling back when the preferred connected account is key-only.
- Preserved key-only operator/local connected Alpaca credentials for shared background/tenant news enrichment when no complete shared credential exists.
- Kept Alpaca REST market-data resolution scoped to `alpaca` connected accounts, excluding `alpaca-mcp` broker rows that belong to MCP execution.
- Preferred current operator connected key-only Alpaca credentials before older stored/env operator keys when no complete connected credential exists.
- Preserved tenant key-only Alpaca credentials before operator key-only fallbacks, so a tenant bearer-token-style credential is not masked by the shared operator news fallback.
- Preserved FMP health logging for optional endpoint failures while suppressing only expected premium `403` rows from optional endpoints.
- Left trading resolution unchanged: `resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant")` still fails closed instead of borrowing the operator's account.

### Why
- The earlier fix checked only the requested user's connected accounts. Background scans and tenants without their own complete Alpaca credentials could still fall through to stale `local` user_api_keys/env values, keeping `alpaca-snapshot` and `alpaca-news` broken when the valid operator key lived only in `connected_accounts`.

### Files
- `src/lib/db-api-keys.ts`
- `src/lib/data-providers.ts`
- `test/data-providers.test.ts`
- `test/key-resolution-tiering.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-27-alpaca-key-fallback-fmp-warnings.md`

### Verification
- `npm ci` - passed in the temporary PR worktree.
- `npm test -- test/key-resolution-tiering.test.ts` - passed, 23 tests after the final Codex review-thread fix.
- `npm test -- test/data-providers.test.ts` - passed, 57 tests after the FMP health follow-up.
- `npx tsc --noEmit --pretty false` - passed cleanly after the final Codex review-thread fix.
- `npm run lint` - passed with 0 errors and 256 existing warnings after the FMP health and Alpaca MCP follow-ups.
- `npm test -- test/key-resolution-tiering.test.ts -t "preserves a tenant key-only Alpaca credential over an operator key-only connected account"` - passed after the final Codex review-thread fix.

### Follow-ups
- Full PR verify/smoke/gitleaks will rerun on GitHub after this branch is pushed.

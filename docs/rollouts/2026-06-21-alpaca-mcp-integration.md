# Rollout Note: 2026-06-21 Alpaca MCP Integration & UI Persistent Buttons

## Summary
Introduced first-class support for **Alpaca MCP** connections in the dashboard, implemented the JSON-RPC SSE transport interface with a seamless REST SDK fallback, and ensured account connection buttons remain persistent so users can connect multiple accounts.

## Rationale
Transitioning to the Model Context Protocol (MCP) for Alpaca provides additional agentic features (like local server integration, improved live order placement, and standardized tool schemas). Keeping the connection buttons visible in the UI ensures that users can connect multiple brokerage accounts (e.g., keeping the Robinhood connection option visible after Alpaca or vice-versa has been configured).

## Files Modified
- [types.ts](file:///Users/jay/apps/trading-antigravity/src/lib/types.ts): Expanded `ConnectedAccount` and `TradingPolicy` types to include `"alpaca-mcp"`.
- [route.ts](file:///Users/jay/apps/trading-antigravity/app/api/connected-accounts/route.ts): Validated `"alpaca-mcp"` as a valid broker type and mapped proper display labels.
- [broker.ts](file:///Users/jay/apps/trading-antigravity/src/lib/broker.ts): Routed `"alpaca-mcp"` active broker configurations to the Alpaca Broker Gateway.
- [execution-mode.ts](file:///Users/jay/apps/trading-antigravity/src/lib/execution-mode.ts): Added description and display mappings for `"alpaca-mcp"`.
- [alpaca.ts](file:///Users/jay/apps/trading-antigravity/src/lib/alpaca.ts): Configured `AlpacaBrokerGateway` to use JSON-RPC SSE requests if configured as `"alpaca-mcp"`, with a fallback to the standard REST SDK client on failure. Corrected order type mappings for stop orders.
- [dashboard-client.tsx](file:///Users/jay/apps/trading-antigravity/app/dashboard-client.tsx): Kept connection buttons always visible and added form prompts for connecting Alpaca MCP Paper/Live accounts.
- [test/alpaca-mcp.test.ts](file:///Users/jay/apps/trading-antigravity/test/alpaca-mcp.test.ts): Verified the gateway adapter calls SSE tools correctly and correctly handles fallbacks.

## Verification Run
- **TypeScript Check**: `npx tsc --noEmit` passed clean.
- **Tests**: `npx vitest run` passed all 401 tests successfully.
- **Build**: `npm run build` compiled Next.js production build cleanly.

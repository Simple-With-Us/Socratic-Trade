# 2026-06-19 - Robinhood MCP transport hardening

## Summary

- Hardened the Robinhood MCP adapter so the app can talk to Robinhood's official
  Trading MCP over Streamable HTTP instead of assuming plain JSON responses.
- Added `GET /api/broker/mcp/health` to report adapter mode, token/auth presence,
  endpoint URL, protocol version, and available MCP tools from `tools/list`.
- Added focused regression tests for SSE parsing, JSON `structuredContent`,
  default endpoint selection, auth/protocol headers, missing-token diagnostics,
  health tool discovery, and JSON-RPC error propagation.
- Kept the concurrent Phase 11 API-key/userId routing work buildable by widening
  API-key service validation and aligning Red Team + post-mortem OpenAI calls with
  `resolveApiKey("openai", userId)`.

## Why

- The external MCP/project review showed that Robinhood's hosted MCP path should
  be treated as HTTP plus SSE (`Accept: application/json, text/event-stream`) with
  an explicit `MCP-Protocol-Version`; the app previously posted JSON-RPC and
  immediately called `response.json()`, which would fail on `text/event-stream`
  responses and made connection failures opaque.
- The dashboard already had the right `RobinhoodGateway` abstraction, so the
  smallest safe backlog slice was transport hardening and diagnostics before
  broader UI/status-card or execution-gate work.

## Files

- `.env.example`
- `app/api/keys/route.ts`
- `app/api/broker/mcp/health/route.ts`
- `src/lib/robinhood.ts`
- `src/lib/red-team.ts`
- `src/lib/post-mortem.ts`
- `test/robinhood-mcp.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-19-robinhood-mcp-transport.md`

## Verification

- `npx vitest run test/robinhood-mcp.test.ts` — 5 tests passed.
- `npx tsc --noEmit` — passed.
- `npm test` — 200 tests passed across 28 files.
- `npm run build` — passed; build output includes `/api/broker/mcp/health`.

## Follow-ups

- Add an in-app Robinhood MCP status card/button in the Accounts or Integrations
  modal once the concurrent `app/dashboard-client.tsx` account-management changes
  settle.
- Continue the broader Phase 11 API-key routing pass; this note only records the
  narrow build fixes needed around the current key catalog and OpenAI-dependent
  strategy helpers.
- Use `/api/broker/mcp/health` against a real authenticated Robinhood Agentic
  account and capture the exact tool list available for the account.
- Add a deterministic execution gate and draft/review/execution/reconciliation
  pipeline before any live order automation beyond the existing policy review
  flow.

## Blockers

- No code blocker. The UI status card was deferred deliberately because the
  settings/account modal file already contains unrelated uncommitted changes.

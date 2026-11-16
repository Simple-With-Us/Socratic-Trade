# 2026-07-01 - broker-capability-fanout

## Summary

Implemented 4 independent, read-only broker-capability items from
`docs/broker-capability-plan.md`'s "cheap, high-value" recommendation list, using the
Workflow tool's parallel-agent orchestration: 4 Opus agents, each in its own isolated git
worktree, working simultaneously. All 4 branches merged into `claude/affectionate-franklin-a52935`
with zero conflicts, then re-verified together as one integrated change.

1. **Broker connection health observability** (`src/lib/alpaca.ts`, `src/lib/robinhood.ts`).
2. **Alpaca account insights** — new `src/lib/alpaca-account-insights.ts`.
3. **Robinhood realized-P&L cross-check** — new `src/lib/robinhood-pnl-crosscheck.ts`.
4. **Chat assistant read-only research tools** — `src/lib/chat/tools.ts` / `orchestrator.ts`.

## Why

The owner asked to "make this an opus ultracode... spawn a bunch of agents" for the
remaining broker-capability work identified in the 2026-06-30/07-01 audit rounds. The 4
items chosen are exactly the ones flagged as "cheap, high-value, no new broker
relationship required" in `docs/broker-capability-plan.md` §10 — genuinely independent of
each other (different files, no shared state), which made them a clean fit for true
parallel execution rather than a pipeline. Each agent was given a tightly-scoped file
allowlist specifically to avoid write conflicts between agents working in isolated
worktrees simultaneously; the partition held — `git merge-tree` showed zero conflicts for
all 4 branches, and merging them one at a time confirmed it (all 4 were fast, conflict-free
merges).

Deliberately excluded, per the plan doc's own risk framing:
- **Robinhood options-trading support** — real trading-capability feature work (new order
  types, new `BrokerGateway` surface, real-money risk) that deserves a dedicated design
  pass, not a parallel-agent sprint alongside unrelated read-only work.
- **eToro / Public.com / IBKR integration** — Codex has separate, unmerged work in this
  area (per the owner, 2026-06-30). Checked `git branch -r` before starting this batch;
  confirmed no eToro/Public/IBKR branch exists yet, so there was nothing to collide with
  today, but this area is still intentionally left alone to avoid stepping on that
  in-flight work once it lands.

## Files

- `src/lib/alpaca.ts` — added a private `trackHealth()` helper wrapping every raw
  `this.alpaca.*` SDK call (`getAccount`, `getPositions`, `getOrders`, `getLatestQuotes`,
  `createOrder`, `cancelOrder`) with `logApiHealth({ service: "alpaca-broker", ... })` on
  both success and failure; re-throws on failure so existing error handling
  (`formatAlpacaOrderError`, the `getEquityQuotes` try/catch) is unchanged. Added a
  `keySource` field (`"user"` for a connected account, `"env"` for the operator fallback).
- `src/lib/robinhood.ts` — wrapped `callRobinhoodMcpTool` (the single funnel every
  Robinhood MCP call passes through) with the same before/after `logApiHealth({ service:
  "robinhood-broker", ... })` pattern.
- `src/lib/alpaca-account-insights.ts` (new) — `fetchAlpacaPortfolioHistory`,
  `fetchAlpacaMarketCalendar`, `fetchAlpacaMarketClock`, `fetchAlpacaAccountActivities`.
  GET-only against Alpaca's Trading API. Private account endpoints resolve only the
  requested user's connected Alpaca account, choose paper/live host per account, and fail
  closed instead of falling back to shared operator market-data credentials. Account
  activities page through Alpaca's `page_token` using the last activity id. Logs health
  under `"alpaca-account-insights"`. Degrades to `undefined`/`[]` on missing credentials
  or failure; never throws, never places an order.
- `src/lib/robinhood-pnl-crosscheck.ts` (new) — `crossCheckRealizedPnl(userId,
  accountNumber, opts?)`: calls Robinhood's `get_realized_pnl` MCP tool, compares against
  this app's live equity realized P&L over the same requested span, filters Robinhood
  per-asset buckets to equities/stocks when bucket metadata is present, and returns a
  5%-tolerance discrepancy result. Robinhood fields are undefined (not thrown) on
  failure/no connection. Diagnostic function only — not wired into any UI/cron/route in
  this change.
- `src/lib/chat/tools.ts` — 3 new `ToolDef` entries (`get_earnings_calendar`,
  `get_option_chain`, `search_instrument`), all `readOnly: true`, each re-validating the
  model's input server-side before calling through `ToolDeps`. 3 new optional `ToolDeps`
  methods (`getEarningsCalendar?`, `getOptionChain?`, `searchInstrument?`), following the
  existing `getFundamentals?`/`getMarketSignals?` optional-dependency pattern.
- `src/lib/chat/orchestrator.ts` — real implementations of the 3 new `ToolDeps` methods in
  `buildProductionDeps`, calling `callRobinhoodMcpTool` with a `robinhoodNotConnected()`
  guard that returns a clear `{ error: "NOT_CONNECTED", message }` result (not a throw)
  when Robinhood isn't linked.
- New test files: `test/alpaca-account-insights.test.ts`, `test/robinhood-pnl-crosscheck.test.ts`,
  plus additions to `test/alpaca-mcp.test.ts`, `test/robinhood-mcp.test.ts`, and
  `test/chat-readonly-tools.test.ts`.
- `STATUS.md`, `PLAN.md` — updated per the handoff protocol (the 4 agents were
  deliberately scoped to only their feature files + tests, so these doc updates were left
  for the integration step, done here).

## Verification

Each agent independently ran `npx tsc --noEmit` + its own relevant vitest file(s) inside
its isolated worktree before finishing (all passed — see each branch's own commit). After
merging all 4 branches into one, then merging current `origin/main` through the mobile
API/PWA merge:

- `npx tsc --noEmit` — clean.
- `npm test` — 172 files / 1671 tests, all passing together (up from 169/1635 before the
  broker fan-out; the delta is the new broker tests plus the already-merged mobile API
  tests).
- `npm run lint` — 0 errors, 258 warnings (existing warning classes, including the Alpaca
  SDK's pre-existing untyped-`any` convention in the new `trackHealth` helper).
- `npm run build` — clean.
- `npm run lint && npx tsc --noEmit && npm test && npm run build` — clean as a full gate.
- Review-fix focused gate: `npx vitest run test/alpaca-account-insights.test.ts
  test/robinhood-pnl-crosscheck.test.ts` — 21 tests passed; `npx tsc --noEmit` — clean.
- Manual safety spot-check (not agent-reported, done directly against the diff): confirmed
  all 3 new chat tools are `readOnly: true`, no order-placement tool was added, and
  `alpaca.ts`'s `trackHealth()` correctly re-throws on failure so no existing error-handling
  behavior changed.

## Follow-ups

- None of these 4 additions are wired into any UI yet (portfolio history/calendar/clock,
  the P&L cross-check, and the new chat tools all exist as callable functions/tool
  definitions with tests, not dashboard surfaces) — that's a separate, smaller follow-up
  if wanted.
- The Robinhood-backed chat tools require the user's Robinhood account to be connected via
  MCP OAuth; they degrade to a "not connected" message otherwise — no action needed, this
  is by design.
- This branch/PR now combines the prior PR #286 stream/fundamentals fixes with this
  broker fan-out, so they land and deploy together.
- Robinhood options-trading support and eToro/Public.com/IBKR integration remain
  explicitly out of scope for this batch (see Why above).

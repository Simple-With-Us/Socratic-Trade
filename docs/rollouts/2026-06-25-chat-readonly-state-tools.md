# 2026-06-25 — Read-only chat state tools (get_portfolio_pnl / get_performance_summary / get_reflection)

Branch: `claude/chat-readonly-state-tools` (off `origin/main`). Clean/additive backlog batch
(post #137/#140). **Additive, read-only, zero execution risk** — the assistant gains a fully
grounded view of the user's own P&L, performance, and reflection so it stops colliding with the
never-invent-numbers rule.

## Summary

The first batch of read-only chat tools (`get_positions`, `get_portfolio`, `list_watchlist`,
`list_alerts`, `list_open_proposals`) already shipped. This adds the three that were still missing
(`docs/chat-assistant-rag-learning.md` I6 NOW tranche):

- **`get_portfolio_pnl`** — realized + unrealized P&L and win rate (live and paper). Sourced from
  `getPerformanceSummary`, with current prices derived from open positions (`marketValue/quantity`)
  so unrealized P&L is real without extra quote calls.
- **`get_performance_summary`** — realized performance broken down by thesis and by regime (trades,
  win rate, avg return %, total P&L). Sourced from `getThesisScorecard` + `getRegimeScorecard`.
- **`get_reflection`** — the latest auto-generated post-mortem reflection (`reflection_summary`
  user-setting written by `post-mortem.ts`).

All three follow the existing optional-dep pattern: a `ToolDef` in `buildTools()` + an optional
`ToolDeps` method wired in `buildProductionDeps()`. Each degrades gracefully (null/empty) when its
dep isn't wired. No allowlist/schema layer to touch — adding a `ToolDef` is sufficient.

## Files

- `src/lib/chat/tools.ts` — 3 result types (`PortfolioPnlResult`, `ScorecardRow`,
  `PerformanceSummaryResult`), 3 optional `ToolDeps` methods, 3 read-only `ToolDef`s.
- `src/lib/chat/orchestrator.ts` — `buildProductionDeps` wires the 3 deps to `performance.ts` +
  `getUserSetting("reflection_summary")`.
- `test/chat-readonly-tools.test.ts` (new) — the 3 tools return dep data and degrade gracefully; all
  flagged read-only.

## Verification

```
npx tsc --noEmit   # clean
npx vitest run     # 1115/1116 (+4); only the pre-existing cache-provenance date flake
npm run build      # compiles green
```

## Follow-ups

Remaining clean/additive backlog (separate branches): `avgDaysHeld`/`shortTermPct` dashboard
surface; persist MAE/MFE per closed lot; ATR-stops opt-in mode; prompt-cache the strategy system
prefix; SEC XBRL company-facts connector.

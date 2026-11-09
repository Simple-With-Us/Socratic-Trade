# Phase 5 - Frontend Refactor And Charts

## Goals

- Split dashboard UI into typed feature components.
- Replace broad `any` usage with shared dashboard types.
- Add performance and allocation charts without making the interface marketing-heavy.
- Make refresh, render, and browser runtime failures visible.
- Improve custom allowlist editing with validated tags, including quote-checked
  non-index U.S. equity/ETF tickers.

## Components

- Scheduler/status summary
- Performance charts
- Allocation chart
- Policy and risk controls
- Profile controls
- Market scan table
- Pending proposals
- Run history
- Audit log

## Acceptance

- `DashboardSnapshot` is a shared type used by the dashboard client.
- Refresh, render, and uncaught browser runtime errors are shown in the UI and do
  not silently disappear.
- Empty states are explicit for positions, orders, scans, proposals, and performance.
- Custom universe editing validates symbols, normalizes case, prevents duplicate
  tags, accepts quote-resolvable non-index tickers, and explains why a custom
  ticker cannot be saved when no quote is available.

## Request-path efficiency + bundle code-split (2026-07-01, branch `claude/trading-audit-d-e-dpw0h7`)

Audit work-split "Chat E" (`docs/reviews/2026-07-01-audit-work-split.md`) — pure
performance refactors of the dashboard request path and client bundle, with no change to
any user-visible number or trading behavior:

- **One fill fetch per request.** `getDashboardSnapshot` now fetches live+paper
  `listFillEvents` once and threads the parsed `FillEvent[]` into `getPerformanceSummary`,
  `getThesisScorecard`, `getRegimeScorecard`, `getTaxSummary`,
  `getClosedLotsDetailed`/`getOpenLots`, the paper-projection, and the unified feed
  (collapsing ~9 redundant 500-row SELECT + FIFO replays to one live + one paper). All new
  params are optional/backward-compatible so other callers are unchanged.
- **Batched proposal lookups.** New `getProposalsByIds` (`WHERE id IN (...)`) replaces up to
  ~150 per-row `getProposal` point-queries with one batched query feeding both feed builders.
- **Unified feed capped at source** (`UNIFIED_FEED_MAX_GROUPS = 60`, newest-first).
- **Client bundle code-split.** `StrategyFlow` (pulling `@xyflow/react`, ~3.9MB) and
  `SymbolDrilldown`/`PriceChart` are now `next/dynamic(..., { ssr: false })` — verified out
  of the dashboard route's initial first-load JS via the react-loadable manifest.
- **DB pragmas** (`cache_size`, `mmap_size`) + a Playwright-CI `.next/cache` restore step.
- **Deferred (track-only):** the monolithic-`snapshot` whole-tree re-render refactor
  (audit §6.1) — a larger `React.memo`/selector-split effort, not attempted here.

See `docs/rollouts/2026-07-01-performance-efficiency.md`.

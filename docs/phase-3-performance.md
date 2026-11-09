# Phase 3 - Performance Tracking And Reconciliation

2026-08-17 trading-outcomes audit (`docs/audits/2026-08-17-trading-outcomes.md`): paper vs live series and FIFO lots remain the performance contract.  Residual validation gaps are paper cost default (1 bps) vs OOS (20 bps), pending_reconciliation zero prints, and missing `outcome_join_coverage_pct` / live mid-vs-fill slippage.

## Goals

- Persist portfolio snapshots, fill events, and run attribution.
- Track Paper results separately from Live broker results.
- Show whether the strategy is making or losing money.
- Keep live reconciliation best-effort when the broker adapter does not expose final fill data.

## Storage

- `portfolio_snapshots`: run id, account, source (`live` or `paper`), execution mode (`broker/paper` or `broker/live`), equity, cash, buying power, positions, created time.
- `fill_events`: proposal id, run id, account, source, execution mode, side, symbol, quantity, price, notional, status, broker order id, raw payload.
- `trade_proposals`: persists execution mode separately from status/source so stale approvals can reject account/mode drift between broker-paper and broker-live proposals.
- `notification_events`: used by Phase 6 but included with the persistence migration.
- `strategy_profiles`: used by Phase 6 but created with the migration so profile state is durable.

## Calculations

- FIFO realized P&L per source.
- Unrealized P&L from current positions and latest prices where available.
- Dashboard top-line Unrealized should use the currently displayed open
  positions' mark-to-cost P&L so it matches the Portfolio rail even when a
  broker-held position predates app-recorded fill lots; learning scorecards and
  realized stats still use app-recorded closed FIFO lots.
- Equity curve from snapshots, separated into live and paper series.
- Run attribution from fill events grouped by run id.
- Win rate and average return from closed FIFO lots.

## Acceptance

- Every strategy run records a portfolio snapshot before proposal execution and after reconciliation.
- Paper executions create fill events with reviewed notional and estimated price.
- Broker-paper executions use the `paper` source bucket with `executionMode = broker/paper`; real brokerage uses `live` with `executionMode = broker/live`.
- Broker-backed executions create pending or filled fill events depending on available broker state, and pending reconciliation queries broker-backed rows directly rather than relying on a capped generic fill list.
- Dashboard API returns `PerformanceSummary` for charting.

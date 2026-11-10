# Day P&L cash-flow cluster (perf-02/03/08)

## Context & Objective

Expert review cluster `cash-flow-and-trading-day` (Part II, `docs/reviews/2026-08-18-full-app-expert-review.md`): Home Day P&L read $0.00 on ordinary trading days because `deriveDayPnl` called `inferExternalCashFlows` with an empty fill list, and short/cover had inverted cash signs minting phantom deposits.  Day boundaries were inconsistent (UTC vs Central).  This PR wires the existing Alpaca account-activities ledger as the primary flow source and keeps inference only as a labeled fallback.

## Changes Made

- `src/lib/trading-day.ts` — shared Central trading-day key + `startOfCentralTradingDay`.
- `src/lib/broker-cash-flows.ts` — map Alpaca CSD/CSW/ACATS activities to per-day flows; `resolveExternalCashFlows` prefers broker ledger.
- `src/lib/cash-flows.ts` — fix short/cover `tradeCash` sign; `isoDate` uses Central day keys.
- `app/console/lib/derive.ts` — pass today's fills + optional `dayPnlHints` into Day P&L; expose `cashFlowSource`.
- `src/lib/benchmark.ts` — accept broker activities for TWR flow neutralization.
- `src/lib/dashboard.ts` — fetch Alpaca activities; set `performance.dayPnlHints`; pass activities to benchmark.
- `src/lib/types.ts` — `DayPnlHints` on `PerformanceSummary`.
- `src/lib/risk-breaker.ts` — Central day key for HWM/SOD storage.
- `src/lib/db-execution.ts` — `DAILY_RESET_TIME_ZONE` → Central (shared helper).
- `app/console/page.tsx` — pass `dayPnlHints` into `deriveDayPnl`.
- `test/day-pnl-cash-flow-cluster.test.ts`, `test/broker-cash-flows.test.ts` — regression tests for perf-02/03.

## Decisions & Trade-offs

- Broker activities replace inference when any transfer rows exist; inference remains for non-Alpaca brokers and is labeled `inferred`.
- Bare `YYYY-MM-DD` Alpaca activity dates are used as-is (not re-parsed as UTC midnight).
- Daily cap / drawdown breaker now roll at Central midnight to match owner-facing Day P&L (was NY for caps, UTC for breaker).
- Did not take on `perf-01` (oldest-500 fill cap) or `last_equity` baseline wiring in this PR.

## Verification State

```bash
npm test -- test/day-pnl-cash-flow-cluster.test.ts test/broker-cash-flows.test.ts test/benchmark.test.ts test/daily-notional-reset.test.ts test/console-live-data-derive.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

All targeted tests pass; lint 0 errors; tsc clean; build succeeds.

## Next Steps & Blockers

- Merge PR; verify on a connected Alpaca account that Day P&L matches broker prior-close + today's market move.
- Follow-up: wire `last_equity` as Day P&L baseline; flow-adjust drawdown HWM (perf-08 remainder).

## Zero-Code Findings

N/A — code changes only.

# 2026-11-23: ops snapshot carries the last vs-SPY benchmark state

## What changes
- New `src/lib/benchmark-state.ts`: an in-process, per-account record of the last benchmark result the dashboard snapshot computed (status ok or unavailable, reason, detail up to 200 chars, cash-flow source, window dates, return percentages, whether the broker ledger was complete, which benchmark sections timed out, computed-at time).
- `getDashboardSnapshot` records it right after `computeSpyBenchmarkDetailed`.
- `/api/ops/snapshot` (token-gated) adds `benchmark` to each account. It is null until a dashboard load has computed one since the process started.

## Safety
- Read-only. No account numbers, no secrets, no new route, no new auth. Capped at 200 accounts.
- No behavior change to the Home card or the benchmark math.

## Rollback
Revert this PR. The field disappears from the ops snapshot; nothing else depends on it.

## Verify after deploy
Load the Home card once, then read `/api/ops/snapshot` and check `accounts[].benchmark`.

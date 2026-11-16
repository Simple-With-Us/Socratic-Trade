# 2026-07-12 — App-wide Audit: Draining State and Cap Fixes

## Summary
Resolved several P0 and P1 issues discovered during the whole-app audit, specifically around the account-deletion race condition and daily notional cap tracking accuracy.

## Why
1. **Account Deletion Race Condition**: Previously, deleting a connected account immediately wiped its database records. If the scheduler was processing open orders or pending fills for that account, the sudden deletion of the account context caused errors, orphaned broker orders, or irreconcilable fills.
2. **Daily Notional Risk Cap Accuracy**: The daily notional risk tracking was querying `created_at` instead of the time an order was actually placed (`placed_at`), which caused orders delayed by the scheduler to fall into the wrong calendar day's cap bucket. It also failed to account for orders in the `placing` intent state, risking double-placing if the sweep overlapped.

## Files Touched
- `src/lib/types.ts`: Added `isDraining` to `ConnectedAccount`.
- `src/lib/db.ts`: Added `is_draining` to the `connected_accounts` schema migration.
- `src/lib/db-api-keys.ts`: Refactored `deleteConnectedAccount` to just set `is_draining = 1`, and introduced `purgeConnectedAccount` for the actual cascading physical deletion.
- `src/lib/scheduler.ts`: Updated the main execution loop to intercept accounts where `is_draining` is true. It now queries the broker to cancel any live equity orders, processes final pending fills to ensure correct final state, and then invokes `purgeConnectedAccount`.
- `src/lib/db-proposals.ts`: Set `placed_at` timestamp when moving proposal status to `placed` or `placing`.
- `src/lib/db-execution.ts`: Refactored `getDailyNotionalUsed` to sum notional value using `coalesce(placed_at, created_at)` and to include proposals in the `placing` state.
- `src/lib/broker-held-orders.ts`: Exported `isRejectedOrCanceledState` which was missing but expected by external files.
- `test/account-delete-cleanup.test.ts`: Updated to call `purgeConnectedAccount`.
- `test/per-account-policy-isolation.test.ts`: Updated to call `purgeConnectedAccount`.
- `test/reconciliation-risk.test.ts`: Updated to expect `partially_filled`.
- `test/logout-route.test.ts`: Updated to respect local dev origin overrides.
- `test/web-sources-sec.test.ts`: Fixed time-based flakiness in form parsing.

## Verification
- Ran the full repository gate locally (`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`). All tests passed successfully.

## Follow-ups
- Merge this branch to `main`.
- Update `#ag***-s**c` slack channel and effort logs.

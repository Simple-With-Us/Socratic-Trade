# 2026-08-02 Strategy and Approval Placement Window Management (PR-2)

## Context & Objective
Following the implementation of the `withAccountMutation` account-wide mutex (PR-1), the next logical step was to harden the risk-creating placement paths in both the strategy execution loop (`src/lib/strategy.ts`) and the manual approval lane (`src/lib/strategy-execution.ts`). By wrapping the placement sequence (from idempotency key creation to DB persistence of the broker response) within the mutation lease, we eliminate race conditions where a concurrent cancel-and-replace or another strategy pass might act on out-of-date account state. This forms the second stage of the Order-State Hardening §7 plan.

## Changes Made
- Wrapped the manual approval placement window in `src/lib/strategy-execution.ts` (`executeApprovedProposal`) with `withAccountMutation` (lane: `approval-placement`, waitMs: 30s). Replaced `lockGuard.assertOwned()` with the lease's `ctx.assertOwned()` right before the risk-creating `gateway.placeEquityOrder` call.
- Wrapped the autonomous strategy placement window in `src/lib/strategy.ts` with `withAccountMutation` (lane: `strategy-placement`, waitMs: 15s). Replaced `lockGuard.assertOwned()` with `ctx.assertOwned()`.
- Retired legacy in-flight memory sets (`stopMonitorInFlight`, `staleExitInFlight`) from `src/lib/scheduler.ts` as they are now fully superseded by the deterministic `withAccountMutation` SQLite lock, avoiding memory-based singleflight guarantees that fail across processes or during restarts.
- Corrected passing `policy.accountNumber` to `row.accountNumber` inside `executeApprovedProposal` where TypeScript correctly flagged that `policy` does not guarantee a populated account number at compile time.

## Decisions & Trade-offs
- Replaced the many `continue;` statements inside the loop body of `strategy.ts`'s placement window with a `return "continue";` semantic to accommodate extracting the synchronous loop body into the async lease callback. This maintains the loop's original control flow cleanly.
- The `scheduler.ts` legacy memory guards were completely removed. While this means the scheduler will dispatch a lease attempt every tick while one is busy, the DB-backed `try-once` (for `stop-monitor`) fails instantly and safely with no penalty, which simplifies process state and removes stateful bugs. For the 15-second `stale-exit-replacement` lane, overlapping promises are acceptable for the Node.js event loop and do not constitute a meaningful memory leak.

## Verification State
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
All checks run green.

## Next Steps
- Open PR, run CI, and merge to deploy to production.
- Move on to the final stage: Weekend Freshness Stage 2/3 (resumption of the worker loop).

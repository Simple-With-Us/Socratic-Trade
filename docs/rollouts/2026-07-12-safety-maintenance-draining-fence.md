# 2026-07-12: Safety Maintenance Coordinator & Draining Fence

## Summary
Completed Wave 0 (PR 1) tasks from the Codex audit roadmap (A21, A28, etc.):
1. **Safety Maintenance Coordinator**: Moved protective tasks (fill reconciliation, stale placing-intent recovery, stale-exit handling, synthetic stops, proposal expiry) to a new coordinator `runSafetyMaintenance` that executes strictly *before* strategy admission. This enforces the single-flight tick structure.
2. **Strict Timeouts**: Broker read calls inside the safety coordinator are wrapped with a `withStrictDeadline` helper (15s total timeout) to prevent the scheduler from hanging indefinitely if the broker connection is stalled.
3. **Draining Fence**: Implemented an explicit `is_draining` and `is_deleted` check immediately before order placement inside `strategy-execution.ts`, safely dropping intents for accounts marked for deletion.
4. **Context Snapshotting**: Captured `accountNumber` and `policyRevision` onto the `strategy_runs` row when the run starts.

## Why
As identified by the Codex cross-platform quality roadmap, we must ensure zero order placements for accounts that are marked as inactive or deleting. Additionally, LLM failures or runaway execution must not block non-LLM safety operations (like reconciling fills and updating risk breakers). By coordinating these strictly before the heavy strategy run, we guarantee safety sweeps execute exactly once per tick even if the subsequent LLM evaluation throws or hangs.

## Files Touched
- `src/lib/db-execution.ts` (schema/type signatures)
- `src/lib/db-settings.ts`
- `src/lib/db.ts` (added migration to retroactively add missing `account_number` and `policy_revision` columns)
- `src/lib/safety-maintenance.ts` [NEW]
- `src/lib/scheduler.ts` (integrated the coordinator; added `isTickRunning` re-entrancy guard)
- `src/lib/strategy-execution.ts` (draining check)
- `src/lib/strategy.ts` (removed manual calls in favor of the coordinator)

## Verification
- `npm run lint` (0 errors)
- `npx tsc --noEmit` (clean)
- `npm test` (3896 tests passing across 349 suites)
- `npm run build` (clean)

## Next
Move on to X0.3 (Exit Replacement State Machine) and X0.4 (Strict P&L Fence) once this lands.

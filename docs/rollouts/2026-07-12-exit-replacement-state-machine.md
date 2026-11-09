# X0.3 Exit Replacement State Machine

## Summary
Migrated `replaceStaleLimitOrderWithMarket` logic from an in-memory execution loop into a robust, database-backed state machine tracked in `order_replacements`. The state machine now handles order replacement safely in concurrent environments without blocking execution loops.

## Why
The previous order replacement mechanism maintained in-flight locks in memory and blocked on the broker's execution loop, exposing the system to memory leaks, silent failures on restart, and re-entrant deadlocks if background and foreground paths collided.

## Files
- `src/lib/order-replacement.ts`: 
  - Restored `original` order fetching during the state machine execution phase for background remediations.
  - Rewired the position-size check (pre-condition guard) to emit `MarketReplacePreconditionError` when a `status = 'aborted'` row is encountered.
  - Updated `autoRemediateStaleExitOrders` to restore the 5-minute cooldown mechanism (using a `SELECT` clause with `-5 minutes`).
  - Added robust try-catch mechanisms to correctly surface and log failures to `audit` during background `stale_exit_auto_remediation_failed` events.

## Verification
- `npm run lint`: 0 errors.
- `npx tsc --noEmit`: Green.
- `npm run test`: All 350 files and 3927 tests passed.
- All 15+ order replacement tests in `order-replacement.test.ts` pass reliably, correctly asserting on explicit DB states instead of relying on in-flight memory maps.

## Follow-ups
- Proceed to Wave 1: **X0.4 Account-bound Command Contract & X0.5 Preemptive STOP**.

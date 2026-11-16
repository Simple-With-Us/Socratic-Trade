# Owner-cancel protective-stop tombstone on cancel timeout

## Context & Objective

#2949 wrote the do-not-replace tombstone after `cancelEquityOrder` returned.  #2886 wraps Alpaca/Tradier cancel in a 30s `withDeadline`.  The broker can accept the cancel and the client still throw `"Alpaca broker call timed out"` / `"Tradier broker call timed out"`.  `cancelWorkingOrder` then never reached the tombstone block.  The next reconcile tick saw the tracked order as terminal (`stale_resting_row`), deleted the row, and re-placed the stop the owner had just removed.

## Changes Made

- `src/lib/order-cancel.ts` — on cancel throw, persist the tombstone from owner intent when the order is a tracked / app-managed protective stop.  Leave the tracked row so a still-live stop is not orphaned if the cancel did not land.
- `test/order-provenance-guard.test.ts` — regression: cancel timeout writes the tombstone; reconcile does not re-place.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

## Decisions & Trade-offs

- Did not add a post-cancel broker read.  Owner intent is enough: if the cancel did not land, the resting row still blocks section 4; if it did, the tombstone blocks re-place after section 3 deletes the row.
- Success-path tombstone + row delete is unchanged.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/order-provenance-guard.test.ts
```

## Next Steps & Blockers

- None for this slice.  Did not touch #2947 / #2952 Tradier list filters.

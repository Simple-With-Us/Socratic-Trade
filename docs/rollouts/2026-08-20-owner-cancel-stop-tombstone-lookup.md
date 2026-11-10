# Owner-cancel protective-stop tombstone on lookup miss

## Context & Objective

#2882 added a per-symbol tombstone so reconcile would not re-place an app-managed protective stop the owner had just cancelled.  The tombstone path required the advisory pre-cancel broker read to return the order.  That read is fail-open and time-bounded: console cancel still executes when the lookup times out, throws, or misses a working GTC stop that is still cancellable by id.

## Changes Made

- `src/lib/order-cancel.ts` — if `lookup.order` is missing, take the symbol from the tracked `broker_protective_stops` row before deciding whether to tombstone and delete that row.
- `test/order-provenance-guard.test.ts` — regression: empty `getEquityOrders` still cancels by id, writes the tombstone, and the next reconcile does not re-place.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

## Decisions & Trade-offs

- Cancel fail-open doctrine is unchanged.  A hung broker READ must still never block the emergency cancel.
- If there is no tracked row and the lookup also missed the order, we still cannot know the symbol or that the order was an app-managed stop.  That path stays without a tombstone.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/order-provenance-guard.test.ts
npm run lint
```

## Next Steps & Blockers

- None for this slice.  Did not touch #2861.

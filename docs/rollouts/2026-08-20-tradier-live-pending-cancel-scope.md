# Tradier getEquityOrders must keep live pending_cancel GTC stops

## Context & Objective

#2886 scoped default `getEquityOrders` to a hand-rolled working-state list (`open` / `pending` / `partially_filled` / `held`) plus terminal orders created in the last 24h.  `isLiveOrderState` already treats `pending_cancel` and `pending_replace` as live because those orders can still fill.  A GTC equity protective stop older than 24h that is mid-cancel is dropped from the default list.  `liveExitOrderCoverage` then sees no exit and the synthetic-stop monitor can place a duplicate sell.  Account-drain can also purge while that order is still live.

This is distinct from #2947 (5-page cap hiding a later-page *open* GTC stop).  #2947 keeps the same 24h terminal filter and does not fix this miss.

## Changes Made

- `src/lib/tradier.ts`: default scoped filter keeps any `isLiveOrderState` row regardless of age.  The 24h window still applies to true terminal rows.
- `test/tradier.test.ts`: regression — week-old `pending_cancel` / `pending_replace` equity stops return on the default path; a week-old filled order does not.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

Touched files:

- `src/lib/tradier.ts`
- `test/tradier.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-tradier-live-pending-cancel-scope.md`

## Decisions & Trade-offs

- Reused `isLiveOrderState` instead of adding two more strings to a local list, so this filter cannot drift from coverage again.
- Did not change page count.  #2947 still owns the 5-page vs 50-page walk.
- Did not change Alpaca.  Its `status:"open"` split already includes in-flight cancel/replace.

## Verification State

```bash
npx vitest run test/tradier.test.ts
# 60/60 pass (includes pending_cancel / pending_replace regression)
npx tsc --noEmit   # pass
npm run lint       # 0 errors (769 grandfathered warnings)
```

## Next Steps & Blockers

- Review + merge.  No deploy from this seat (main auto-deploys).
- #2947 remains OPEN and CONFLICTING for the separate 5-page cap.

## Zero-Code Findings

None.

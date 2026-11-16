## Context & Objective

ST-4592: Tradier Sandbox day-TIF OTOCO structures stayed pending after session end and flattened exit legs lacked attribution, so the Orders screen labeled them `external`.

## Changes Made

- Propagate container `tag` onto flattened OTOCO/OTO legs as `parentClientOrderId` + `parentOrderId` and set `orderClass` (`otoco`/`oto`/`oco`) without copying `tag` onto exit `clientOrderId` (placement reconciliation unchanged).
- `resolveTradierBracketContainerState` maps stale container `open` to terminal entry-leg state (`expired`/`canceled`) for reconciliation.
- `isAppPlacedBrokerOrder` and `loadOrderRoleContexts` honor `parentClientOrderId`; `isContingentOrderLeg` treats parent-linked legs as contingent.

## Files touched

- `src/lib/tradier.ts`
- `src/lib/types.ts`
- `src/lib/broker-side.ts`
- `src/lib/order-provenance.ts`
- `src/lib/order-role-context.ts`
- `test/tradier-otoco-attribution.test.ts`
- `test/tradier.test.ts`
- `test/order-provenance.test.ts`

## Decisions & Trade-offs

- Exit legs still omit `clientOrderId` on purpose; attribution rides on `parentClientOrderId` so container idempotency stays one-to-one.
- Listing ingest still books filled app bracket exits (unchanged); attribution fix targets classification and stale pending reconciliation.

## Verification State

```bash
npx tsc --noEmit
npm run lint
npm test -- test/tradier-otoco-attribution.test.ts test/tradier-fill-reconciliation.test.ts test/tradier.test.ts test/tradier-order-lookup.test.ts test/order-provenance.test.ts
```

## Zero-Code Findings

- `connected_accounts.is_active=0` with `systemState=active` is not a bug: `is_active` is the console's loaded-account pointer; autonomy `systemState` is per-account policy from `trading_policies`.

## Next Steps

- None; await review.

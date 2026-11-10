# Stop intent authoritative absence fix

## Summary

Fixed broker protective-stop placement intent reconciliation so a missing client order id only clears
the durable intent when the broker gateway explicitly says its order list includes recently-terminal
orders. Non-authoritative/live-only lists now leave the intent in place and skip fresh placement for
that symbol instead of risking a duplicate full-size stop.

## Why

The stop-intent lane was added to survive a crash or timeout after a broker accepted a protective
stop but before the app received the response. The follow-up reconcile path treated any successful
order-list fetch with no matching `clientOrderId` as proof the earlier request never landed. That is
safe for Alpaca's status-all order list, but not for brokers such as Robinhood where absence from the
list cannot distinguish "never placed" from "accepted, filled, and no longer visible." Retrying in
that state could leave two resting sell stops for the same shares or sell again after a fast fill.

## Files

- `src/lib/broker-protective-stops.ts`
- `test/broker-protective-stops.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-21-stop-intent-authoritative-absence.md`

## Verification

- `npm test -- test/broker-protective-stops.test.ts` (70 tests passed)
- `npm test -- test/broker-protective-stops.test.ts test/synthetic-stops.test.ts` (138 tests passed)
- `npm run lint` (exit 0; warnings only)
- `npx tsc --noEmit`
- `npm test` (420 files / 4,901 tests passed)
- `npm run build` (passed; existing Next/Sentry Edge-runtime warning only)

## Follow-ups

- Existing RAG purge bug remains tracked separately in automation memory; PR #1840 is still open and
  was not duplicated by this fix.

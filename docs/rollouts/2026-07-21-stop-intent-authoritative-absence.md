# Stop intent authoritative absence fix

## Summary

Fixed broker protective-stop placement intent reconciliation so a missing client order id only clears
the durable intent when the broker gateway explicitly says its order list includes recently-terminal
orders. Non-authoritative/live-only lists keep fresh intents in place and skip fresh placement for
that symbol instead of risking a duplicate full-size stop, but retire them after a bounded
successful-list grace so a later/reopened position cannot remain blocked forever.

Review remediation adds two further lifecycle guarantees: unresolved intent symbols now suppress
both synthetic-stop registration and fire in the same tick, and intent reconciliation runs before
closed-position, feature-disabled, plan-excluded, stopped, or live-preflight early returns. A
visible live intent is cancelled, a visible executed intent is booked atomically, and genuinely
ambiguous outcomes remain durable.

## Why

The stop-intent lane was added to survive a crash or timeout after a broker accepted a protective
stop but before the app received the response. The follow-up reconcile path treated any successful
order-list fetch with no matching `clientOrderId` as proof the earlier request never landed. That is
safe for Alpaca's status-all order list, but not for brokers such as Robinhood where absence from the
list cannot distinguish "never placed" from "accepted, filled, and no longer visible." Retrying in
that state could leave two resting sell stops for the same shares or sell again after a fast fill.

Keeping such an intent forever was also incorrect: a closed and later reopened symbol inherited the
old row indefinitely, and the synthetic monitor could still fire because only broker placement was
suppressed. Lifecycle-aware cleanup plus a five-minute successful-list grace bounds both failures
without treating a failed order fetch as evidence.

## Files

- `src/lib/broker-protective-stops.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/synthetic-stops.ts`
- `test/broker-protective-stops.test.ts`
- `test/synthetic-stops.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-2-correctness.md`
- `docs/rollouts/2026-07-21-stop-intent-authoritative-absence.md`

## Verification

- Review-remediation focused run: `npx vitest run test/broker-protective-stops.test.ts test/synthetic-stops.test.ts`
  - passed (2 files, 143 tests).
- `npx tsc --noEmit` - passed after the final lifecycle regression update.
- `npx eslint src/lib/broker-protective-stops.ts src/lib/db-api-keys.ts src/lib/synthetic-stops.ts test/broker-protective-stops.test.ts test/synthetic-stops.test.ts`
  - passed with 0 errors and 4 pre-existing warnings.

### Original implementation

- `npm test -- test/broker-protective-stops.test.ts` (70 tests passed)
- `npm test -- test/broker-protective-stops.test.ts test/synthetic-stops.test.ts` (138 tests passed)
- `npm run lint` (exit 0; warnings only)
- `npx tsc --noEmit`
- `npm test` (420 files / 4,901 tests passed)
- `npm run build` (passed; existing Next/Sentry Edge-runtime warning only)

## Follow-ups

- Hold the local closeout behind PR #1857. Once released, push it to PR #1844's existing head,
  resolve the three review threads, obtain fresh required checks, merge, and verify the exact
  auto-deployed production SHA.
- Existing RAG purge bug remains tracked separately in automation memory; PR #1840 is still open and
  was not duplicated by this fix.

# Order provenance guard — auto-replace only app-owned orders

## Context & Objective

Part II cluster `order-provenance-guard` from `docs/reviews/2026-08-18-full-app-expert-review.md`.  Stale-exit auto-remediation was cancel-replacing bracket take-profit legs, owner GTC sells, and re-placing protective stops the owner had just cancelled.

## Changes Made

- Added `src/lib/order-provenance.ts` with app-placement / bracket-leg skip helpers and a per-symbol manual-cancel tombstone for app-managed protective stops.
- `src/lib/order-replacement.ts` — enqueue + pump skip bracket legs and non-app orders; dedupe live typed-confirm deferral audits.
- `src/lib/stale-limit-orders.ts` — suppress stale-limit alerts on activated bracket legs.
- `src/lib/order-cancel.ts` — record tombstone + delete `broker_protective_stops` row when the owner cancels an app-managed stop.
- `src/lib/broker-protective-stops.ts` — honor tombstone in section-4 placement.
- Tests: `test/order-provenance-guard.test.ts`, `test/stale-limit-orders.test.ts`, `test/order-replacement.test.ts` (default `clientOrderId` on fixtures).

## Decisions & Trade-offs

- Manual `replaceStaleLimitOrderWithMarket` is unchanged — owner-initiated replace stays available.
- Tombstone is per (user, account, symbol) until policy changes clear it (no automatic expiry this PR).
- `clientOrderId` absence means "not app-placed" for auto-remediation only.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/order-provenance-guard.test.ts test/stale-limit-orders.test.ts test/order-replacement.test.ts test/mobile-order-cancel.test.ts
npm run build
```

All four commands pass on the branch.  Full `npm test` has pre-existing unrelated failures in other files.

## Next Steps & Blockers

- None for this cluster.  Related clusters (`placement-outcome-truth`, `broker-io-deadlines`) remain separate PRs.

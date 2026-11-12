# ST-4616: money-path order invariant properties

## Context & objective

The placement choke point in `src/lib/order-position-invariant.ts` is what stops a sell from opening a short and a cover from opening a long.  This pass adds seeded property tests that place orders through `getBrokerGateway` and read the Alpaca and Tradier payloads.  Two of those cases were real bugs.  The design record stays `docs/rollouts/2026-09-24-st-order-correctness.md`.

## Changes made

- A seeded generator (mulberry32, seed `0x4616`, 1000 cases per broker) builds positions and orders and asserts the eight payload properties in `test/order-position-invariant-properties.test.ts`.  Shrunk examples cover the share-class miss, the Tradier partial dollar limit sell, and the quantity-only hint.
- `heldPositionFor` matches `BRK.B` to a `BRK-B` position.  Global `normalizeSymbol` is unchanged.
- Tradier partial dollar exits are resolved to a share quantity from the position's own per-share value, and capped at the shares held.  If a broker-verified position cannot be priced, the exit is refused (`dollar_exit_unpriced`, terminal) and nothing is sent.  If the position only comes from the caller's hint after a failed broker read, the refusal is the retryable `position_unverified`.  If Tradier's quote batch failed, the position value is cost basis (`marketValueSource: "cost_basis"` from `src/lib/tradier.ts`), and every dollar exit, full or partial, is refused as retryable `position_unverified` instead of being sized from the entry price.  Against a cost-basis short, no dollar order is rewritten: there is no side flip, no leg stripping, and no quantity.  The autopilot holds back a dollar buy, or a long-only market dollar sell, before side normalization and sizing, and audits it as `proposal_position_unverified` (code `position_unverified`); the next run re-proposes it.  At the placement choke point every dollar buy or cover against an unpriced short, including one with a zero or negative quantity, is refused as retryable `position_unverified` and audited as `order_position_invariant_refused`.  A sell of a short is always the terminal `sell_against_short` at the choke point, because a sell there can never become a cover.  A zero or negative dollar buy is not a position refusal.  A quote price only values a position after a Zod parse as a finite positive number; anything else leaves the position at cost basis.  Alpaca partial dollar sells stay notional.

Files:

- `src/lib/order-position-invariant.ts`
- `test/order-position-invariant-properties.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-12-st-4616-money-path-properties.md`

## Decisions & trade-offs

- fast-check is not a dependency.  The generator is local and deterministic.
- Explicit short entries still skip the invariant, and only when `allowedProposalSides` includes `short`.
- Alpaca partial dollar sells stay dollar-sized.  Tradier has no notional field, so the same dollars were being sized from a limit or a quote and could exceed the position.
- A quantity-only hint has no market value.  A Tradier dollar exit against that hint is refused instead of sized from a quote.
- Tradier duration for an extended-hours limit follows the wall-clock pre/post windows in `tradierExtendedHoursDuration`.  The generator clock only freezes the sandbox open deferral.
- An unverified Tradier read still fails open on an explicit close verb.  The property does not require that pass-through to be clamped.

## Verification state

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx vitest run test/order-position-invariant-properties.test.ts test/order-position-invariant.test.ts
```

Node 26.13.1. `npm run lint` exited 0 (warnings only).  `npx tsc --noEmit` exited 0 after the dead `c.side !== "short"` comparison was removed.  `npx vitest run test/order-position-invariant-properties.test.ts test/order-position-invariant.test.ts` passed.  Full `npm test` was 18 failed, 10233 passed, 41 skipped.  The failures are in unrelated suites (provider keys, notify, host metadata) and none are in the order-invariant files.  `npm run build` exited 0 with `NODE_OPTIONS=--max-old-space-size=6144` after the default heap aborted.

Merged `origin/main` `81f483dd` (ST-4595 origin lock, ST-4603 liveness clocks).  Git auto-merged `STATUS.md` and `PLAN.md` with no conflict markers.  Both sides' entries stayed.  After that merge, on Node 26.13.1: `npx vitest run test/order-position-invariant-properties.test.ts test/order-position-invariant.test.ts` passed (44 tests), `npx tsc --noEmit` exited 0, and `npm run lint` exited 0 (0 errors, warnings only).

`origin/main` then moved to `878d8edf` (ST-4612 org slug).  A second merge commit kept the ST-4616 entry and main's STATUS history edits.  No conflict markers.  On Node 26.13.1 after that merge: the two order-invariant files plus `test/github-org-slug.test.ts` passed (45 tests), `npx tsc --noEmit` exited 0, and `npm run lint` exited 0 (0 errors, 869 warnings).

## Next steps & blockers

PR #5160 stays open.  `verify` must be green.  Do not merge, do not enable auto-merge, and do not deploy.  Jay reviews the money-path behavior change: share-class matching, and Tradier dollar exits that become a capped share quantity or a refusal.

## Zero-code findings

None.  The two payload failures were product bugs and are fixed in this change.

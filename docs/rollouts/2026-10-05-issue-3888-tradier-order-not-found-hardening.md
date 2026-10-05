# Issue #3888 — harden isTradierOrderNotFound

## Context & Objective

Follow-up from PR #3798 review: keep real Tradier 404 and 422-envelope missing-order handling for `getEquityOrder`, but stop classifying unrelated HTTP bodies whose prose happens to contain an order not-found phrase.

## Changes Made

- Gate the order not-found regex on `Tradier HTTP 422` (errors envelope path) in `isTradierOrderNotFound` (`src/lib/tradier.ts`).
- Correct stale comment at `cancelBracketSiblingLegs` (422 prefix is present on the envelope throw path).
- Extend `test/tradier-order-lookup.test.ts` with 422 not-found → `undefined`, and 400/502 prose collision → throw.

Files:

- `src/lib/tradier.ts`
- `test/tradier-order-lookup.test.ts`
- `docs/rollouts/2026-10-05-issue-3888-tradier-order-not-found-hardening.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- `cancelBracketSiblingLegs` still uses its own inline not-found check (out of scope per issue); only the shared helper and comment were touched there.
- 422 envelope messages that omit an order-scoped not-found phrase remain throws (same as before the unanchored regex could match only when `order…not found` appeared).

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test -- test/tradier-order-lookup.test.ts   # 11 passed
npm run build         # clean
```

Full-suite `npm test` on this cloud seat reported 9 unrelated failures in other files (pre-existing / environment); CI `verify` is the merge gate.

## Next Steps & Blockers

- Merge after green `verify`; no prod behaviour change beyond safer error classification on future `getEquityOrder` callers.

## Zero-Code Findings

None.

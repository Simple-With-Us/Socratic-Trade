# Issue #3888 — harden isTradierOrderNotFound

## Context & Objective

Follow-up from PR #3798 review: keep real Tradier 404 and 422-envelope missing-order handling for `getEquityOrder`, but stop classifying unrelated HTTP bodies whose prose happens to contain an order not-found phrase.

## Changes Made

- Gate the order not-found check on `Tradier HTTP 422` (errors envelope path) in `isTradierOrderNotFound` (`src/lib/tradier.ts`), including bare `Tradier HTTP 422: not found` from `{errors:{error:"not found"}}`.
- Correct stale comment at `cancelBracketSiblingLegs` (422 prefix is present on the envelope throw path).
- Extend `test/tradier-order-lookup.test.ts` with 422 not-found (order-scoped and bare envelope) → `undefined`, and 400/502 prose collision → throw.

Files:

- `src/lib/tradier.ts`
- `test/tradier-order-lookup.test.ts`
- `docs/rollouts/2026-10-05-issue-3888-tradier-order-not-found-hardening.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- `cancelBracketSiblingLegs` still uses its own inline not-found check (out of scope per issue); only the shared helper and comment were touched there.
- Unrelated 422 validation messages (not bare `not found` and not order-scoped) still throw.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test -- test/tradier-order-lookup.test.ts   # 11 passed (includes bare 422 envelope case)
npm run build         # clean
```

CI `verify` on PR #4212 is the merge gate.

## Next Steps & Blockers

- Merge after green `verify`; no prod behaviour change beyond safer error classification on future `getEquityOrder` callers.

## Zero-Code Findings

None.

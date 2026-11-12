# Issue #3888 — harden isTradierOrderNotFound

## Context & Objective

Follow-up from PR #3798 review: keep real Tradier 404 and 422-envelope missing-order handling for `getEquityOrder`, but stop classifying unrelated HTTP bodies whose prose happens to contain an order not-found phrase.

## Changes Made

- Anchor `isTradierOrderNotFound` on `^Tradier HTTP 404` and on `^Tradier HTTP 422:` with body parsed only after that prefix (`src/lib/tradier.ts`): bare `not found`, order-scoped phrase at body start; never match echoed `Tradier HTTP 422: not found` inside a non-422 message (e.g. `Tradier HTTP 502: …`).
- Correct stale comment at `cancelBracketSiblingLegs` (422 prefix is present on the envelope throw path).
- Extend `test/tradier-order-lookup.test.ts` with 422 not-found (order-scoped and bare envelope) → `undefined`, 400/502 incidental prose → throw, and `502echo422` (502 body echoing the 422 envelope string) → throw.

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
npm test -- test/tradier-order-lookup.test.ts   # 11 passed (bare 422 envelope + 502echo422)
npm run build         # clean
```

CI `verify` on PR #4212 is the merge gate.

## Next Steps & Blockers

- Merge after green `verify`; no prod behaviour change beyond safer error classification on future `getEquityOrder` callers.

## Zero-Code Findings

- Reusable lesson: Scope Tradier missing-order detection to validated HTTP 404 and HTTP 422 not-found envelopes (status prefix at message start, body parsed after `Tradier HTTP 422:`) rather than generic error prose, so unrelated broker failures still reach normal retry and error handling.

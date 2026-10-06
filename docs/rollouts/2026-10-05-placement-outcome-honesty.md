# 2026-10-05 — Placement honesty remainder

## Context & Objective

Board `d2094c78ff79447d` (`placement-outcome-truth`): Approve must not report success when nothing was placed, and a retryable broker 4xx must not be filed as a terminal rejection.  A prior slice already landed (mobile command status, approval-path HTTP 429/408 → `not_placed`).  PR #3343 then made `executeProposal` throw for several non-placement outcomes and broke re-approval (Seer HIGH).  This change closes the remaining honesty holes without adding throws inside `executeProposal`.

## Changes Made

`classifyPlaceOrderError` is the shared class for both lanes.  HTTP 429/408 are `retryable` and book `not_placed`.  HTTP 409 and a duplicate `client_order_id` (`must be unique` / `already exists` / `duplicate`, including Alpaca HTTP 422) are `idempotency_conflict` and fall through to the existing refId reconcile.  Other HTTP 4xx stay `rejected_terminal`.  The autonomous run previously treated every HTTP 4xx except 409 as `rejected_by_broker`; it now uses the same class.  Mobile `proposal.approve` throws `ProposalNotPlacedError` only when the returned status is outside `placed` / `filled` / `paper`, and the command is failed with that structured result.  Busy still returns from `executeProposal`.  The #3343 throws (decline, missing order id, absent order, uncertain) stay throws.  Console home and the approval card share `toastForApproveResult`.  Home still titles a placement "Approved".  The card still titles "BUY AAPL placed".

Touched files:

- `src/lib/placement-outcome.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/strategy.ts`
- `src/lib/mobile-api.ts`
- `app/console/lib/approval-honesty.ts`
- `app/console/page.tsx`
- `app/console/components/approval-card.tsx`
- `test/placement-outcome.test.ts`
- `test/placement-reconcile.test.ts`
- `test/console-approval-honesty.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-05-placement-outcome-honesty.md`

## Decisions & Trade-offs

Did not throw new errors from `executeProposal`.  Reprice re-approval, broker-minimum blocks, and owner-consent drift keep their current return-or-throw contract.  A duplicate `client_order_id` is not immediately `not_placed`.  Reconcile first: order present → placed; authoritative list and order absent → `not_placed`.  An invalid `client_order_id` that is not a duplicate stays terminal.  `OrderValidationError` is classified before the HTTP class so a validation message that mentions HTTP 429 stays blocked.  No iOS change.  The command is already failed when the result is not placed, and Linux cannot compile Swift.  No Coolify deploy.  The live board `/Users/jay/apps/TRADING-EFFORT-LOG.md` is not on this VM; the repo mirror was updated.

## Verification State

Failing first, before the classifier existed: `classifyPlaceOrderError is not a function`; HTTP 422 duplicate + order present threw the raw 422 from the terminal branch; HTTP 422 duplicate + order absent did not match `/safe to retry/`.  HTTP 429 on the approval path already persisted `not_placed`.

After the fix, targeted vitest:

```bash
npx vitest run test/placement-outcome.test.ts test/placement-reconcile.test.ts test/mobile-placement-command.test.ts test/console-approval-honesty.test.ts test/order-confirmation-status.test.ts
```

36 passed.  Mobile busy → command `failed` with outcome `busy`.  HTTP 429 → `not_placed`, not `rejected_by_broker`.  HTTP 422 duplicate + order present → `placed`.  HTTP 422 duplicate + order absent → `not_placed`.  HTTP 409 + order present still `placed`.  Synchronous decline still throws and stays `rejected_by_broker`.

`npx tsc --noEmit` clean.  `npx eslint` on the touched files: 0 errors (existing warnings only).

`npm test` (vitest): 9 failed, 9050 passed, 51 skipped.  None of the 9 are in the placement files.  They are environment noise on this VM: Alpha Vantage pool dispatch count, Congress share breaker call count, `summarize-cpuprofile.mjs` failing to load a `.ts` file under plain Node, notify tests seeing a redacted env credential instead of empty, and server-metrics `usesLocalHost`.  Placement files in that run passed.

`npm run lint` (`eslint .`) exited 0: 0 errors, 863 existing warnings.  `npm run build` passed (exit 0).  Static pages generated.

## Next Steps & Blockers

Open the PR ready.  Do not merge.  Do not deploy.  If Kodus comments, fix or defer with a rationale.  Do not resolve a thread only to merge.  There is no isolated autonomous-loop fixture; the autonomous 429/422 path is the same `classifyPlaceOrderError` the approval tests pin.

**2026-10-06 tip-fix (PR #4229).**  Rebased onto `origin/main` with no conflicts.  `isDuplicateClientOrderIdError` now requires uniqueness wording within 80 chars of `client_order_id` on the same clause (`.` boundary) so unrelated HTTP 422 bodies stay `rejected_terminal`.

## Zero-Code Findings

The green "Approved" mobile bug for a returned `busy` status was already closed on main (`executeMobileCommand` mapped non-placed outcomes to `failed`).  This change moves that check into the `proposal.approve` case as `ProposalNotPlacedError` so the command still fails with the structured result.  Generic throws from `executeProposal` (including the existing 429 throw after booking `not_placed`) still fail the command without that structured payload.  That is the #3343 contract and was left alone.

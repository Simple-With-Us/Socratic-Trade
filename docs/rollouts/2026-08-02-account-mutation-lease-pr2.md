# 2026-08-02 — §7 slice 3 PR-2: strategy/approval placement windows under the mutation lease

**Agent:** MONET · branch `monet/broker-mutation-mutex-pr2` (off `origin/main`)
**Completes:** the two-PR plan from `docs/rollouts/2026-08-02-account-mutation-lease-pr1.md`.

## 1. Context & Objective

PR-1 leased the risk lanes; the money-path placement windows still fired the advisory
`broker_mutation_unleased` receipt. PR-2 wraps them: the approval lane's claim→place→book
span (`executeProposal`) and the autonomous loop's per-proposal placement span, closing §7
slice 3. Implementation was delegated to a mid-tier builder against the panel-synthesis
spec, then adversarially reviewed (3 lenses + refuters, 10 agents): 5 findings confirmed,
2 refuted, all 5 fixed in a second builder round.

## 2. Changes Made

- **`strategy-execution.ts` (`executeProposal`)** — the span from the
  `claimProposalForExecution` CAS through the success return runs inside
  `withAccountMutation` (lane `approval-placement`, waitMs 30s; lease acquired BEFORE the
  claim so a busy exit leaves the proposal in `proposed`, nothing to revert). Busy →
  honest `{ status: "busy" }`. `mutationCtx.assertOwned()` fences the place call.
  Optional `leaseWaitMs` threaded so **bulk-approve** shares ONE lease-wait budget across
  the whole batch (review finding: 30s × N serial worst case in one HTTP request).
- **`strategy.ts` (run loop)** — each proposal's placement sequence (fresh
  protective-state re-read → place → outcome bookkeeping incl. reconcile) runs inside
  `withAccountMutation` (lane `strategy-placement`, waitMs 15s). The span's nine
  `continue` exits became `{done:"continue"}` markers; success returns `{done:"placed"}`.
  Busy → the pre-inserted `placing` ledger row lands `not_placed` with the busy reason
  (deliberate doctrine deviation, documented at both ends: the strategy lane mints its
  ledger row pre-window so busy skips stay visible; the approval lane follows the
  no-row-on-busy rule).
- **`operation-lease.ts`** — new exported `OperationLeaseOwnershipError`; every
  ownership-loss throw site constructs it. **Review finding (medium):** the fence throw
  was previously laundered through `reconcilePlacementError` — on Robinhood
  (non-authoritative order list) that stranded a `placing` row and emitted
  `order_placement_uncertain`, feeding the broker-health run suppressor for a non-broker
  fault. Both placement catches now short-circuit the typed error to `not_placed` +
  `order_not_placed_lease_lost` audit + notification, never contacting the broker.
- **Tests** — `test/account-mutation-pr2.test.ts` (approval busy → still-`proposed` with
  literal never-claimed assertions; lease-loss regression asserting zero
  `order_placement_uncertain`); `test/account-mutation-pr2-strategy-loop.test.ts` (held
  lease → run completes, row `not_placed`, zero fills; release → placed/filled, one
  fill). Sibling file keeps its broker-module mock scoped away from the approval suite.

## 3. Decisions & Trade-offs

- Strategy busy results carry `status: "error"` in the run results array (existing shape)
  with a distinct safe-to-retry reason; the row status is the honest `not_placed`.
- The fence sits inside the existing placement try; the typed short-circuit makes the
  route direct. No restructuring of the try/catch.
- The re-indent-dominated diff was reviewed via `git diff -w` against pre-move originals;
  all ten span exits verified equivalent (review lens 1, zero confirmed span-fidelity
  defects).

## 4. Verification State

- tsc clean; eslint 0 errors (warnings pre-existing, verified by before/after diff).
- Builder sweeps: 13 files / 92 tests green (incl. approval-lock, operation-lease,
  strategy-lock guard/loss, run-strategy-offline, e2e-money-path, placement-reconcile ×2,
  broker-minimum-bump-execute).
- Adversarial review: 10 agents, 5 confirmed / 2 refuted, all 5 fixed (details above).
- Full `npm test` + `npm run build` via `scripts/land.sh` at landing.

## 5. Next Steps & Blockers

- §7 slice 3 is COMPLETE with this landing. Slice 4 (uniform protection receipts) remains
  planned/unassigned. The `broker_mutation_unleased` receipt should now be RARE in
  production — a spike of it is a new-unwrapped-lane signal (grep the audit kind).
- This PR's deploy creates the first container with the freshness stopgap removed —
  the freshness lane's live re-enable test rides this cutover (watch the boot).

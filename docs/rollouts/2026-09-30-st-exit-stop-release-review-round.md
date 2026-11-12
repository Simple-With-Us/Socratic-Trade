# 2026-09-30 — Exit Stop Release Review Round (#3793 Follow-Up, Lane H1)

Seat CLAUDE, board `687a5fb4`, branch `claude/st-w3-h1`.  Follow-up to PR #3793 ("Approved exits
release the app's own resting protective stop"), whose rollout note is
`docs/rollouts/2026-09-25-st-exit-vs-resting-stop.md`.

## Context & Objective

PR #3793 merged on 2026-09-27 before its review findings were addressed.  Two independent reviewers
reported three findings.  This lane verifies each against current `main`, fixes the real ones
test-first, and records the verdicts here.

| # | Severity | Finding | Verdict |
|---|---|---|---|
| 1 | P1 | The exit is placed without a final mutation-lease re-check right before the risk-creating broker call | **Confirmed, fixed** |
| 2 | P2 | The restore reconcile uses the run's stale `policy.systemState`, so it can act as if not halted | **Confirmed, fixed** |
| 3 | P2 | No test exercises the cover-of-a-short exit path | **Confirmed (coverage gap only), tests added** |

None were declined.

### Finding 1 — Final placement fence (confirmed)

Both lanes fence before calling `placeExitReleasingOwnStops`: the autopilot loop
(`src/lib/strategy.ts`, `freshPlacementBlockReason` then `mutationCtx.assertOwned()`) and the
approval path (`src/lib/strategy-execution.ts`, the same pair with `source: "owner_approval"`).
But the release sequence then awaits a fresh position and order read, one cancel plus a settle poll
per stop (up to `CANCEL_SETTLE_POLL_MAX_MS`), a position re-read, and several SQLite writes before it
calls `place`.  `assertOwned` was only re-checked before each cancel, never after the last settle,
and the durable system state was never re-read.  Every other placement path checks at the last
synchronous boundary: `order-replacement.ts` calls `input.fence?.()` immediately before
`placeEquityOrder`, and both strategy lanes call `mutationCtx.assertOwned()` directly before their
own `placeEquityOrder`.  So a window that lost its lease mid-release could still send the exit, and
an owner Stop pressed while a stop was being cancelled did not stop the exit.

Fix: `finalPlacementFence` re-reads the caller's durable system-state fence (new optional
`placementBlockReason` on the run, wired to the same `freshPlacementBlockReason` call each lane
already uses) and then `assertOwned`, synchronously, with no `await` between the check and `place`.
It runs on both the release path and the "nothing to release" path.

Found while tracing the same code: on the "nothing to release" branch, `place` ran inside the
`try` whose `catch` treats any non-`ExitStopReleaseError` as "re-plan unavailable" and falls through
into the release path with the caller's older plan.  A broker error on the exit itself (for example
an HTTP 503) was swallowed there, the stop was cancelled, and the same exit was submitted a second
time.  `place` now runs outside that `try`, so a broker error on the exit propagates once to the
caller, which reconciles by `refId` as before.

### Finding 2 — Restore reconcile on stale state (confirmed)

`restoreProtectionAfterRelease` passed `haltedProtectOnly: policy.systemState === "halted"` from
`run.policy`, which the autopilot lane reads before LLM deliberation and the approval lane reads at
the start of the approval.  If the owner pressed Stop in between, the restore reconcile ran as
active: it could place new protection for other unprotected positions and cancel-replace stops, the
initiating actions a halt forbids (see the `haltedProtectOnly` contract in `synthetic-stops.ts`).

Fix: `currentRestorePolicy` re-reads `getPolicy(userId, connectedAccountId)` at restore time, the
same read `freshPlacementBlockReason` does, and accepts it only when it resolves to this very
account (same connected-account id and account number).  When it cannot be read or tied to this
account, the run's policy is used with the halt treatment and an
`exit_stop_release_restore_state_fallback` audit row: the released stop is still put back (a halt
treats that as restoring existing protection, never looser than the released trigger), and nothing
new is started.

### Finding 3 — Cover-of-a-short coverage (confirmed gap)

No test covered a cover.  The code path was already side-agnostic (`backingQuantity`,
`evaluateBrokerHeldExitAvailability`, the reconciler's buy-side stop), and the three new cover tests
pass on `main` unchanged, so this was a coverage gap, not a behavior bug.  The fake broker now
enforces held quantity for buy/cover orders against a short, the same way it already did for sells.

## Changes Made

- `src/lib/exit-stop-release.ts`: `finalPlacementFence` + `failFinalPlacementFence` (system state,
  then lease, immediately before `place`; roll back a released stop on failure); `place` moved out
  of the re-plan `try`; new `placementBlockReason` run field and `placement_blocked` error code;
  `currentRestorePolicy` for the restore reconcile's halt decision and policy.
- `src/lib/strategy.ts`: autopilot lane passes `placementBlockReason` (same
  `freshPlacementBlockReason` call as its existing fence).
- `src/lib/strategy-execution.ts`: approval lane passes `placementBlockReason` with
  `source: "owner_approval"`.
- `test/exit-stop-release.test.ts`: 9 new tests (3 cover, 4 final fence, 2 restore state); fake
  broker holds short shares against buy/cover orders.
- `test/exit-stop-release-approval.test.ts`: 1 new end-to-end test through `executeProposal` (owner
  Stop lands while the stop is being cancelled); `seedPolicy` split out of `seed`; `onCancel` hook.
- Docs: this note, `STATUS.md`, `docs/EFFORT-LOG.md`.

## Decisions & Trade-offs

- **Fence order.**  System state is checked before the lease.  If both fail, the owner sees the
  Stop reason; the rollback re-checks the lease itself, so protection is still never placed from
  outside the lease.
- **After a release, a failed fence rolls back.**  With the lease still held, the released stop is
  re-placed now (under a halt, via the restore path the halt allows).  With the lease lost, the
  restore is marked owed (`restore_pending`) for the next lease holder's protective-stop pass, the
  same rule the existing mid-release lease loss follows.
- **Error types match the callers' existing handling.**  A system-state block throws an
  `ExitStopReleaseError` (an `OrderValidationError`), so both lanes record the proposal as
  `blocked`, exactly like their own fresh-state block.  A lost lease rethrows the original
  `OperationLeaseOwnershipError`, so both lanes keep their `not_placed` / lease-lost handling.
- **Fallback takes the halt treatment.**  When the current state cannot be tied to this account,
  putting back only the released stop is right whether or not the owner pressed Stop.  Both
  production callers pass a connected-account id, so the fallback should be rare; the audit row
  makes it visible.
- **Not changed:** the fresh re-plan still reads the `exitsReleaseAppStops` toggle from the run's
  policy.  An owner flipping that toggle during one run is a narrower case, and the release is
  always followed by a restore.  Left as a possible follow-up.

## Verification State

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts
#   2 files, 29 passed
# Same two files against main's src (git checkout origin/main -- the three src files):
#   7 failed | 22 passed — every new fence and restore-state test fails; the 3 cover tests pass
npx tsc --noEmit
npx eslint src/lib/exit-stop-release.ts src/lib/strategy.ts src/lib/strategy-execution.ts test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts
```

Results: the two test files pass (29 tests); eslint on the five changed files reports 0 errors.
The full `npx tsc --noEmit` did not finish locally: it was killed by its timeout twice (20 and about
40 minutes) with the Mac at load average 250 to 360, so the required `verify` CI job is the type
gate for this PR.  `npm run build` was not run locally (no
route or client/server boundary change; the required `verify` CI job runs the full suite and the
build).

## Next Steps & Blockers

- Review, then remove `do-not-automerge` and merge (a review stage owns that).
- After deploy, watch for `exit_stop_release_placement_blocked` (an owner Stop landed mid-release)
  and `exit_stop_release_restore_state_fallback` (should be close to zero; a steady stream means the
  connected-account id is not reaching the run).
- Optional follow-up: read the `exitsReleaseAppStops` toggle fresh in the in-lease re-plan.

## Zero-Code Findings

- The cover path was already correct; the gap was test coverage only.
- `freshPlacementBlockReason` blocks every side when halted (both sources), so the new fence stops
  an exit under a halt the same way the callers' existing fence does.

## Review Round (PR #4005, 2026-09-30)

The review of this PR returned two P2 findings.  Both were verified against the branch and both
are real; none were declined.

| # | Severity | Finding | Verdict |
|---|---|---|---|
| R1 | P2 | Transient release failures land as terminal `blocked` (pre-existing from #3793) | **Confirmed, fixed** |
| R2 | P2 | The autopilot lane's `placementBlockReason` wiring has no test and fails open if dropped | **Confirmed, fixed** |

### R1 — Transient release refusals booked terminal (confirmed)

`ExitStopReleaseError` extends `OrderValidationError`, and both lanes only special-case
`isRetryablePositionInvariantError`, which matches `OrderPositionInvariantError` alone.  So the two
transient release codes fell through to the generic `OrderValidationError` branch and were booked
terminal `blocked`: `position_unverified` (the position re-read after the cancel failed) and
`stop_cancel_unconfirmed` (the cancel did not settle in time).  In both cases nothing reached the
broker and the released stop was rolled back.  Reproduced before the fix: a single post-cancel
position read timeout booked the approved exit `blocked` in both lanes.

Fix: new `isRetryableExitStopReleaseError` in `src/lib/exit-stop-release.ts` (true for exactly
those two codes).  Each lane gets a branch right after its position-invariant branch that books
`not_placed`, audits `order_not_placed_exit_stop_release` with the code, and notifies "exit not
placed ... (safe to retry)".  `still_held`, `exit_moot_stop_filled` and `placement_blocked` stay
terminal on purpose: a retry cannot change an owner order holding the shares, a closed position,
or the owner's Stop.

### R2 — Autopilot fence wiring untested and optional (confirmed)

Only the approval lane had an end-to-end test of the final placement fence, and both fences were
optional on `ExitStopReleaseRun`, so deleting the `placementBlockReason` line in `strategy.ts`
kept every test green.  Mutation check before the fix: with that line removed, the new autopilot
test fails because the exit is sent (`["BAC", "sell", "market", 24]` reaches the broker).

Fix: `assertOwned` and `placementBlockReason` are now REQUIRED on `ExitStopReleaseRun`, so a lane
that drops either one fails to compile (a `@ts-expect-error` unit test pins that down, since `tsc`
covers `test/`).  New `test/exit-stop-release-autopilot.test.ts` drives the real
`runStrategyOnce` through the release path: the owner's Stop lands on THIS account while the stop
cancel is in flight, and the test asserts the exit never leaves, the released stop is put back for
all 24 shares, and the proposal is `blocked` with an `exit_stop_release_placement_blocked` audit.
It seeds the halt on the run's own connected account, so wiring the fence to the wrong account id
also fails it.

### Review Round Files

- `src/lib/exit-stop-release.ts`: `isRetryableExitStopReleaseError`; `assertOwned` and
  `placementBlockReason` required (optional-call sites now plain calls).
- `src/lib/strategy.ts`: autopilot retryable `not_placed` branch for the two transient codes.
- `src/lib/strategy-execution.ts`: approval retryable `not_placed` branch for the same codes.
- `test/exit-stop-release-autopilot.test.ts` (new): 2 end-to-end autopilot tests (owner Stop
  mid-release; post-cancel position read timeout books `not_placed`).
- `test/exit-stop-release-approval.test.ts`: 1 new test (post-cancel position read timeout books
  `not_placed`, stop put back); `failPositionReads` hook on the mocked broker.
- `test/exit-stop-release.test.ts`: 3 new tests (retryable classification; both fences required by
  the type; the notification title names the cause per code); every direct call now passes both
  fences explicitly (`OPEN_FENCES` where a test is not about them).
- `src/lib/exit-stop-release.ts`: `retryableExitStopReleaseTitle` (used by both lanes): a failed
  post-cancel position re-read and an unconfirmed stop cancel no longer share one title that said
  the release "did not settle".
- Docs: this section, `STATUS.md`, `docs/EFFORT-LOG.md`.

### Review Round Decisions

- **A separate branch, not a wider `isRetryablePositionInvariantError`.**  That helper's audit kind
  and notification say "position unverified", which would mislabel a stop cancel that did not
  settle.  The new branch keeps its own audit kind and carries the code.
- **Both fences required, not just `placementBlockReason`.**  The same fail-open argument applies
  to the lease fence; both production callers already pass both.
- **The restore-state test keeps an open placement fence.**  "Owner halts mid-release" in
  `test/exit-stop-release.test.ts` isolates the restore reconcile, so it passes an explicit
  `placementBlockReason: () => undefined`; the placement fence under a halt is covered by the
  unit fence test and both lanes' end-to-end tests.

- **Notification title per code.**  The first cut of R1 gave both codes one title ("protective
  stop release did not settle"), which mislabels `position_unverified`, the same mislabeling the
  separate branch exists to avoid.  `retryableExitStopReleaseTitle` picks the title by code.
- **Merged `main` into the branch.**  GitHub reported the PR as conflicting with no checks
  dispatched; `git merge` of `origin/main` (#4007, #4009 and the Renovate / dependency bumps) was
  clean, and the PR is mergeable again.  A test-only typing fix in the autopilot test's fake broker
  (`type` cast to `OrderType`, like `side`) was committed before the merge.

### Review Round Verification

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts test/exit-stop-release-autopilot.test.ts test/order-position-invariant-lanes.test.ts
#   before the fix: 3 failed (R1 in both lanes, R1 classification); with the strategy.ts
#   placementBlockReason line deleted, the autopilot Stop test fails (the exit is sent)
#   after the fix: 4 files, 37 passed
npx eslint src/lib/exit-stop-release.ts src/lib/strategy.ts src/lib/strategy-execution.ts test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts test/exit-stop-release-autopilot.test.ts
#   0 errors (49 pre-existing warnings in strategy.ts / strategy-execution.ts, none on changed lines)
npx tsc --noEmit
#   pending at commit time (load average 250-350); the required `verify` CI job is the type gate
```

Fix-up pass (after the `main` merge and the per-code title, head `2b204ed6d`):

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts test/exit-stop-release-autopilot.test.ts test/order-position-invariant-lanes.test.ts
#   4 files, 38 passed (833 s at load average 500-950)
npx eslint src/lib/exit-stop-release.ts src/lib/strategy.ts src/lib/strategy-execution.ts test/exit-stop-release.test.ts test/exit-stop-release-approval.test.ts test/exit-stop-release-autopilot.test.ts
#   0 errors, 49 warnings (pre-existing, none on changed lines)
timeout 3500 npx tsc --noEmit
#   killed by the timeout again (exit 124, load average 300-950)
```

CI on `2b204ed6d`: `verify`, `verify-hosted` (tsc, full vitest suite, build, 15m34s) and
`verify-ios` all passed, so `verify-hosted` is the type gate of record for this PR.


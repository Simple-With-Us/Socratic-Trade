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

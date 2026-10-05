# SQLite off-loop wedged reclaim (Kody PR #4164)

## Context & Objective

Kody flagged that matching the execution timeout to the caller deadline, without a started-slot reclaim, left wedged FTS workers pinned after caller abort won the race.  A later review found the reclaim map itself leaked when the slot died before that timer fired.  This note covers both, on branch `grok/lexical-fts-off-event-loop`.

## Changes Made

Rebased onto latest `origin/main` (no merge commit).  Main's axios 1.20.0 bump (#4014) and Cursor cloud env (#4178) are kept.  This branch's lexical FTS off-loop and reclaim behavior is kept.

- Keep the start-armed execution timer when a started request settles via caller `AbortSignal`.  Track those waiters in `reclaimById`.
- `onExecutionTimeout` retires the slot even when the waiter already settled.  `clearExecutionReclaim` drops the timer when the worker replies after a caller abort.
- Disarm (`reclaimById.delete` and `clearTimeout`) runs before the `waiter.slot.disposed` return in `onExecutionTimeout`.  A disposed slot used to skip that cleanup and pin the `Pending` closure for the process lifetime.
- `killSlot` sweeps reclaim entries for that slot, including the early return when the slot is already disposed.  `settleReject` can re-add a started waiter, so the sweep is after that loop.
- `resetSqliteAllOffLoopForTesting` disarms timers via `clearExecutionReclaim` instead of dropping map entries and leaving timers armed.  Slots marked disposed without `killSlot` are removed from the pool array.  Reset still terminates the captured workers.
- Tests: reclaim after caller abort when the execution budget fires.  Reclaim count is 0 after abort plus slot retirement, and after the execution timer fires on an already-dead slot.

Files:

- `src/lib/rag/sqlite-all-offloop.ts`
- `test/sqlite-all-offloop.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-05-sqlite-offloop-reclaim-kody.md`

`PLAN.md` and phase docs are unchanged.  This does not change product scope.

## Decisions & Trade-offs

Caller abort alone still does not `killSlot` synchronously (warm pool).  Wedged `.all()` is reclaimed when the start-armed budget fires, when the worker finishes and clears reclaim, or when the slot is retired.

No Slack #agent-sync post was sent from this cloud VM, and no board card id was invented.  The STATUS claim line is `repo: Simple-With-Us/Socratic-Trade` and `pr: #4164`.  There is no linked track issue.

The live board path `/Users/jay/apps/TRADING-EFFORT-LOG.md` is not on this VM.  The repo mirror `docs/EFFORT-LOG.md` has the row.

## Verification State

Mandated full check is CI `verify` (workflow `CI`), which runs `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`, plus the related jobs on the PR (`verify-hosted`, `verify-ios`, `gitleaks`, `check-pin`, `classify`).  That `verify` job was green on the pre-rebase head `4ca11431` (run `37282382569`).  These rebase and leak-fix commits are not claimed against a finished local full suite.  No dev server was running, so none was restarted.

Additional local note, not a substitute for `verify`:

```bash
npx vitest run test/sqlite-all-offloop.test.ts --testTimeout=20000
```

24 tests passed (2026-10-05, this cloud VM).

## Next Steps & Blockers

Push to `grok/lexical-fts-off-event-loop` with `--force-with-lease` because the branch was rebased.  Re-arm squash auto-merge if the rebase cleared it.  Comment on PR #4164 with the commit SHAs for each open Kody thread.  Resolve a thread only when that SHA clearly fixes it.

## Zero-Code Findings

Fleet recall accepted one lesson: `contrib/GROK/2026-10-05/59e3d453` (category `lesson`, app `socratic-trade`, seat `GROK`).  Command that succeeded:

```bash
recall contribute "A start-armed bounded worker must keep an independent execution deadline after the caller cancels, until the worker responds or that deadline fires, or an abandoned job pins a pool slot.  When the slot dies first, drop the reclaim entry and disarm that timer immediately, including when the timeout handler observes the slot is already disposed and when the module is reset.  Clearing a map without clearTimeout, or returning before the delete because the slot is disposed, retains the job payload and the settle closures for the process lifetime.  Listener removal on the dying worker is not cleanup: the reply path never runs." --category lesson --app socratic-trade
```

The cloud call also passed `seat: GROK`.  Recall was available.  This was not a skipped contribute.

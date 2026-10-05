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
- Tests: reclaim after caller abort when the execution budget fires.  Reclaim count is 0 after caller abort and a worker `exit` (that handler runs `killSlot`, then a replacement query succeeds).  Awaiting `worker.terminate()` from the test deadlocks because `killSlot` removes the `exit` listener that promise is waiting on.  Reclaim count is also 0 after the execution timer fires on a slot marked disposed without `killSlot`.
- `LexicalRowSchema.section` accepts null so one NULL section does not fail the off-loop batch.  `mapLexicalRows` still omits a blank section.
- Worker `RequestSchema` bind params are an explicit better-sqlite3 union.  `sqliteAllOffLoop` rejects the same union before post.  `statement.all` runs only after `safeParse` succeeds.
- Worker pragmas are fixed literals (`busy_timeout = 100`, `cache_size = -20000`, `mmap_size = 268435456`).  The parent throws if those constants drift.
- A malformed worker response for a known id settles through `settleReject`, so a started waiter keeps its execution timer and `reclaimById` entry.

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

Mandated full check is CI `verify`, which runs `npm run lint`, `npx tsc --noEmit`, full `npm test` (unfiltered Vitest), and `npm run build`.

**Verification:** the required `verify` job completed **SUCCESS** on the prior head.  It is the authoritative full-suite proof and is not replaced by a path-filtered local Vitest.  This Kody-fix commit is not claimed against a finished local full suite until that job is green on the new head.

Additional targeted local note only (not a substitute for `verify`):

```bash
npx vitest run test/sqlite-all-offloop.test.ts --testTimeout=20000
```

No dev server was running, so none was restarted.

## Next Steps & Blockers

Push new commits to `grok/lexical-fts-off-event-loop` with a fast-forward push.  Do not force-push.  Re-arm squash auto-merge if a push cleared it.  Comment on PR #4164 with the commit SHA for each open Kody thread.  Resolve a thread only when that SHA clearly fixes it.

The earlier rebase onto `origin/main` already landed.  This follow-up does not rebase again unless `origin/main` moves ahead.

## Zero-Code Findings

Fleet recall already holds the worker-lifecycle invariant.  Search on 2026-10-05 (`recall_search`, app `socratic-trade`, category `lesson`, source `agent-contribution`, limit 5) returned these records before any further contribute:

- `contrib/GROK/2026-10-05/59e3d453` — disarm reclaim when the slot dies first.
- `contrib/GB-COMPILER/2026-10-05/0952b86c` — every slot teardown clears per-request bookkeeping.
- `contrib/GROK/2026-10-05/dc248598` — clear reclaim maps before a disposed guard.
- `contrib/BF-FIXER/2026-10-02/a8cf4751` — stall-lane watchdog SIGKILL (different invariant).
- `contrib/BF-FIXER/2026-10-01/00cd51c7` — corpus-wide lexical query as the stall cause (different invariant).

No second contribution.  The start-armed reclaim lesson is already in the corpus.

# 2026-10-21 - st-4550-stall-test-guard

## Summary

`test/event-loop-stall-hot-path.test.ts` no longer inserts 2,000,000 rows to time a function that
reads nothing.  The `pruneTaskJournal` case now asserts the invariant that still has a subject: the
retention hook never deletes a row, not even one that the retired 24-hour skipped-row policy would
have aged out.  The case runs in milliseconds and can fail.

Both counts are scoped to the rows this case inserts, and the aged fixture is asserted present before
the hook runs, so the guard cannot pass on an empty table and cannot be tripped by an unrelated
writer in the suite's shared database.

## Why

`src/lib/db-task-journal.ts:272` is a permanent no-op:

```ts
/** Jay policy (2026-10-15): task journal rows are kept forever; scheduler still calls this hook. */
export function pruneTaskJournal(_now: Date = new Date()): number {
  return 0;
}
```

The old case, "pruneTaskJournal no-op stays under 100ms when a full scan of the same rows does not",
built a two-million-row table so that an unindexed `COUNT(*)` scan would exceed 100ms, then asserted
that the prune stayed under 100ms.  Its own title says the subject is a no-op.  A function that
returns a constant reads nothing, so the wall-clock half of the assertion was decided by the machine
and not by the code: the scan could not be fast without 2,000,000 rows in the table, and the prune
could not be slow because it never ran.  The insert loop alone took roughly 60 seconds against a
60-second vitest timeout, so the case failed by timing out rather than by asserting.

That cost the required `verify` gate real runs.  It reddened hosted verify on PR #4720 (19:42Z) and
on PR #4701 (19:59Z), neither of which has this file in its diff, and it reproduced locally at 60 to
83 seconds.  It was filed twice for the same defect: as **ST-4550** (P1) and as **ST-4564** (P2).  A
required gate reddening on an unrelated pull request is the failure mode this file has been causing,
and it is the only part of the file that was still doing any work.

The serving-thread stall of 2026-10-05 that this file was written for came from the `DELETE` that
the retention policy later removed.  With the `DELETE` gone, the wall-clock half of the guard has no
subject left, so keeping it pays 60 seconds per run to say nothing.

The replacement keeps the part that still holds and can still fail, and it puts the rest of the
guard where it already lives:

- The never-deletes invariant is now asserted here, on 1,000 rows aged 90 days, in milliseconds.  Both
  counts are scoped to the rows this case inserts, so an unrelated writer in the suite's shared
  database cannot move them, and a control assertion proves the aged fixture is present before the
  hook runs, so the guard cannot pass vacuously on an empty table.
- The source-level no-`DELETE` check is already in `test/forever-retention-no-age-delete.test.ts`.
- The keep-all-rows contract is already in `test/task-journal.test.ts:118`.
- The scheduler still calling the hook is already in `test/scheduler-tick-reentrancy.test.ts`.

Nothing was weakened: the retired assertion was undecidable, and the new one has a subject.

## Files

- `test/event-loop-stall-hot-path.test.ts` — the `pruneTaskJournal` case, rewritten.
- `docs/rollouts/2026-10-21-st-4550-stall-test-guard.md` — this note.
- `STATUS.md` — the state entry.
- `PLAN.md` — the scope entry.

No production code changed.  `src/lib/db-task-journal.ts` is untouched.

## Verification

Fails-first proof, with the mutant as the subject.  Two mutants were used, one per assertion, so
that neither half of the guard is left unproven.

Mutant A re-enabled the retired policy's aged-row `DELETE` inside `pruneTaskJournal` and reported the
number of rows it deleted:

```ts
export function pruneTaskJournal(_now: Date = new Date()): number {
  const cutoff = new Date(_now.getTime() - TASK_JOURNAL_SKIPPED_RETENTION_MS).toISOString();
  const info = getDb()
    .prepare("DELETE FROM task_journal WHERE status = 'skipped' AND started_at < ?")
    .run(cutoff);
  return info.changes;
}
```

Under the mutant the new case failed at the return assertion, not by timing out:

```
FAIL  test/event-loop-stall-hot-path.test.ts > ... > pruneTaskJournal is a retention no-op that never deletes an aged row
AssertionError: expected 1000 to be +0
 ❯ test/event-loop-stall-hot-path.test.ts:125:32
     125|     expect(pruneTaskJournal()).toBe(0);
```

Mutant B deleted the same aged rows and then reported zero.  That is the dangerous shape, because a
hook that claims it deleted nothing while it deleted something passes a return-value assertion on its
own.  It failed at the row-count assertion instead:

```
AssertionError: expected +0 to be 1000
 ❯ test/event-loop-stall-hot-path.test.ts:128:25
     128|     expect(agedAfter.c).toBe(agedBefore.c);
```

Both mutants were reverted with `git checkout -- src/lib/db-task-journal.ts`, and the source file was
confirmed byte-identical to `HEAD`.  The unmutated case passes:

```
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  6.27s
```

Full local gate, in the repo's order, run in the lane at
`/Users/jay/apps/lanes/Socratic-Trade/minimax-st-4550-stall-test-guard` on branch
`minimax/st-4550-stall-test-guard`:

- `npm run lint` — 866 warnings, **0 errors**, exit 0.
- `npx tsc --noEmit` — exit 0.
- `npm test` — **860 test files passed, 1 skipped (861); 9,696 tests passed, 51 skipped (9,747); 0
  failed**, exit 0.  The retired case is not in the failure list.
- `npm run build` — exit 0.

The gate was re-run in full after the review fix below.  The second run was on a different tree, because the branch had merged `origin/main` forward by then, and its test counts differ, so both runs are recorded here rather than the better one:

| Run | Tree | Test files | Tests | Failed |
| --- | --- | --- | --- | --- |
| First | branch head, before the review fix | 860 passed, 1 skipped | 9,696 passed, 51 skipped | 0 |
| Second | branch head after the review fix and the merge-forward of `d91b757f5` | 859 passed, 1 skipped, 1 failed | 9,695 passed, 51 skipped | 2 |

The two failures in the second run are both in `test/sqlite-all-offloop.test.ts`, which is not this pull request's file and is byte-identical to the copy in `main`.  Both assert a fixed wall clock on a follow-up query, and the machine was at a load average of 79 to 91 on 10 cores while that suite ran, so the host decided them.  The file passes in isolation, passes on the hosted runner, and the defect is filed as **ST-4573** with its measurements and its fix.

Cost, measured against the old case on the same schema with the same three indices: 50,000 rows
insert in 158ms, 200,000 in 680ms, 500,000 in 1,267ms, 2,000,000 in 6,848ms on an idle box, and the
unindexed scan over those rows took 4ms, 28ms, 68ms and 309ms respectively.  The real insert path is
slower than that probe because it also carries WAL and the surrounding load, which is how the old
case reached the 60-second timeout under CI load.  The new case inserts 1,000 rows.

## Review findings

The automated review opened two findings on this pull request on 2026-10-21 at 20:09Z, both on the
replacement case, and both were correct.

The first was that the guard had no control proving the aged fixture was present, so it could pass on
an empty table.  The second was that the guard counted the whole shared `task_journal` table, so an
unrelated writer in the suite's shared database could move the counts and fail the case for a reason
that had nothing to do with the hook.  The retired case had no fixture to prove and no row count to
couple, because it asserted a wall clock.

Both were fixed in the same commit:  the counts are now scoped to `task_name = 'stall-probe'`, the rows
this case inserts, and the aged fixture is asserted present before the hook runs.  Mutant B in the
verification section exists because of the second finding, since a hook that deletes and reports zero
is the shape that a return-value assertion alone cannot catch.

## Follow-ups

- **ST-4564** is the same defect filed a second time, as a P2.  It should be closed as a duplicate
  of **ST-4550** rather than worked separately, so the two rows stop disagreeing about the
  severity of one file.
- **ST-4573** is the other wall-clock defect that this work's own second gate run found in the suite, and it is the same class this note is about: a wall-clock assertion with no code on the other side of it.  Two cases in `test/sqlite-all-offloop.test.ts` assert a fixed wall clock on a follow-up query, and the pool's slot count is 0 by then, so the query runs on a worker the host has to create on demand and the assertion measures the machine rather than the pool.  It is filed, fixed on its own branch, and the fix replaces the wall clock with two assertions that have different subjects:  the count of queries the pool dispatched for the follow-up, and the move in the live slot count that `activeSqliteOffLoopSlotCountForTesting` reports.  The
fixed reclaim sleep became a poll with a 5,000ms ceiling instead of a sleep, so the reclaim check
no longer rides on a wait a loaded host can stretch.  Rollout: `docs/rollouts/2026-10-21-st-4573-offloop-wall-clock-budget.md`.
- The other two cases in this file still carry wall-clock assertions.  They have real subjects: the
  ROIC artifact walk and the transcript coverage read are both real I/O, and both were rewritten
  when the 2026-10-05 stalls were found.  They were left alone on purpose, because a sweep that
  rewrites assertions that are not broken trades a decidable guard for a cheap one.

## Blockers

None.

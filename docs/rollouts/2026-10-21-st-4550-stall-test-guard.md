# 2026-10-21 - st-4550-stall-test-guard

## Summary

`test/event-loop-stall-hot-path.test.ts` no longer inserts 2,000,000 rows to time a function that
reads nothing.  The `pruneTaskJournal` case now asserts the invariant that still has a subject: the
retention hook never deletes a row, not even one that the retired 24-hour skipped-row policy would
have aged out.  The case runs in milliseconds and can fail.

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

- The never-deletes invariant is now asserted here, on 1,000 rows aged 90 days, in milliseconds.
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

Fails-first proof, with the mutant as the subject.  The mutant re-enabled the retired policy's
aged-row `DELETE` inside `pruneTaskJournal`:

```ts
export function pruneTaskJournal(_now: Date = new Date()): number {
  const cutoff = new Date(_now.getTime() - TASK_JOURNAL_SKIPPED_RETENTION_MS).toISOString();
  const info = getDb()
    .prepare("DELETE FROM task_journal WHERE status = 'skipped' AND started_at < ?")
    .run(cutoff);
  return info.changes;
}
```

Under the mutant the new case failed at the assertion, not by timing out:

```
FAIL  test/event-loop-stall-hot-path.test.ts > ... > pruneTaskJournal is a retention no-op that never deletes an aged row
AssertionError: expected 1000 to be +0
 ❯ test/event-loop-stall-hot-path.test.ts:106:32
     106|     expect(pruneTaskJournal()).toBe(0);
```

The mutant was then reverted with `git checkout -- src/lib/db-task-journal.ts`, and the source file
was confirmed byte-identical to `HEAD`.  The unmutated case passes:

```
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  12.88s
```

Full local gate, in the repo's order, run in the lane at
`/Users/jay/apps/lanes/Socratic-Trade/minimax-st-4550-stall-test-guard` on branch
`minimax/st-4550-stall-test-guard`:

- `npm run lint` — 869 warnings, **0 errors**, exit 0.
- `npx tsc --noEmit` — exit 0.
- `npm test` — **860 test files passed, 1 skipped (861); 9,696 tests passed, 51 skipped (9,747); 0
  failed**, 2355.68s, exit 0.  The retired case is not in the failure list.
- `npm run build` — exit 0.

Cost, measured against the old case on the same schema with the same three indices: 50,000 rows
insert in 158ms, 200,000 in 680ms, 500,000 in 1,267ms, 2,000,000 in 6,848ms on an idle box, and the
unindexed scan over those rows took 4ms, 28ms, 68ms and 309ms respectively.  The real insert path is
slower than that probe because it also carries WAL and the surrounding load, which is how the old
case reached the 60-second timeout under CI load.  The new case inserts 1,000 rows.

## Follow-ups

- **ST-4564** is the same defect filed a second time, as a P2.  It should be closed as a duplicate
  of **ST-4550** rather than worked separately, so the two rows stop disagreeing about the
  severity of one file.
- The other two cases in this file still carry wall-clock assertions.  They have real subjects: the
  ROIC artifact walk and the transcript coverage read are both real I/O, and both were rewritten
  when the 2026-10-05 stalls were found.  They were left alone on purpose, because a sweep that
  rewrites assertions that are not broken trades a decidable guard for a cheap one.

## Blockers

None.

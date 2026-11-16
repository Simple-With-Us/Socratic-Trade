# 2026-10-21 - st-4573-offloop-wall-clock-budget

## Summary

Two cases in `test/sqlite-all-offloop.test.ts` asserted a fixed wall clock on a follow-up query.
Both assertions are gone, and the state they were standing in for is now asserted directly:  the
pool has to dispatch exactly one new query for the follow-up, and the live slot count has to move up
by exactly one, which says the pool retired the wedged worker and served the follow-up from a fresh
one.

No production code changed.  The file is a test file.

## The defect

`test/sqlite-all-offloop.test.ts` asserted this in two cases:

```ts
const startedAt = Date.now();
const rows = await sqliteAllOffLoop("SELECT 7 AS c", [], dbPath, CountRowSchema, { timeoutMs: 5_000 });
expect(rows).toEqual([{ c: 7 }]);
expect(Date.now() - startedAt).toBeLessThan(200);
```

and, in the second case, `expect(Date.now() - startedAt).toBeLessThan(minMs / 2)`.

The two cases are named "reclaims a wedged slot after caller abort when the execution budget fires"
and "retires a wedged slot when the execution budget fires".  In both, the pool has just retired a
worker that was running a wedged statement, and the follow-up query is the proof that the pool is
still usable.

The wall clock was not measuring the pool.  It was measuring the host, and here is why.

`selectSlot()` in `src/lib/rag/sqlite-all-offloop.ts:588` starts a fresh slot whenever the live
slots are fewer than `SQLITE_OFF_LOOP_POOL_SIZE` and none of them is idle:

```ts
function selectSlot(): PoolSlot {
  const active = slots.filter((slot) => !slot.disposed);
  const hasIdle = active.some((slot) => slotLoad(slot) === 0);
  if (active.length < SQLITE_OFF_LOOP_POOL_SIZE && (active.length === 0 || !hasIdle)) {
    return createSlot();
  }
  ...
```

`killSlot` removes the retired slot from `slots` synchronously, so after the retire the pool is
empty and the follow-up always starts a brand new worker.  The follow-up therefore cannot queue
behind the wedged statement, and it cannot wait it out either.  All that is left in its elapsed
time is the cost of creating a worker and running a trivial query on it, which is a property of
this machine and not of the pool.

That is the whole defect.  The assertion could only ever fire because the host was slow, which is
what happened on the machine that filed the row: the follow-up took 364ms against a 200ms budget
in one case and 905ms against a 300ms budget in the other, while the machine sat at a load average
of 79 to 91 on 10 cores.  The file is not in those pull requests' diffs, so the gate reddened on
work that had nothing to do with it.

## The first design, and why it was wrong

The first attempt at a replacement sized the wedge from a measurement and gave the follow-up a
deadline derived from it: a constant `WEDGE_STATEMENT_MS` of 1,500ms, a `measureCountMs` helper
that ran the same recursive count uncached, and a follow-up deadline of
`Math.max(WEDGE_STATEMENT_MS / 2, wedgeCostMs / 2)`.

It passed every check it was given, on a loaded machine, and it was wrong.  On a free machine the
sizing probe cannot reach 1,500ms, because `iterationsTakingAtLeast` doubles from 100,000 and
breaks when the measured time reaches the target or the iteration count reaches 8,000,000.  The
doubling overshoots that cap, because the step below it is 6,400,000 and doubling that gives
12,800,000, so 12,800,000 is the count the probe reports when it gives up:

```
Error: sqlite statement did not reach 1500ms (last 918ms at 12800000)
```

The probe threw, both cases failed, and the design was dead.  The lesson is the same one the
ST-4550 note records: a check that cannot fail is worse than no check, and a proof that only
holds on the machine that produced it is not a proof.  This design was measured only under load,
and it was caught the moment the same file ran on a quiet box.

That attempt is recorded here rather than deleted, because the reason it failed is the reason the
second design works.

## The fix

Two changes, both in `test/sqlite-all-offloop.test.ts`.

The wall clock assertions are gone, and in their place the follow-up is checked two ways at once:

```ts
const dispatchesBeforeFollowUp = dispatches;
const slotsBeforeFollowUp = activeSqliteOffLoopSlotCountForTesting();
expect(slotsBeforeFollowUp).toBe(0);
const rows = await sqliteAllOffLoop("SELECT 7 AS c", [], dbPath, CountRowSchema, { timeoutMs: 5_000 });
expect(rows).toEqual([{ c: 7 }]);
expect(dispatches - dispatchesBeforeFollowUp).toBe(1);
expect(activeSqliteOffLoopSlotCountForTesting()).toBe(slotsBeforeFollowUp + 1);
```

The two counts have different subjects, so neither one implies the other.  `dispatches` counts the
queries the pool handed to a worker, read from the started hook the parent calls when it sees the
worker's started notice.  The live slot count is the pool's own bookkeeping.  A dispatch that never
reached a worker would move the first and not the second, and a slot the pool never counted would
move the second and not the first.  Both are decidable on any host.

The live count is 0 immediately before the follow-up, because the retire or the reclaim already
emptied the pool, so the count can only move if the follow-up started a fresh worker.  It states
what the wall clock was reaching for, which is that the wedged worker was retired and the follow-up
was not served by it.

The reclaim wait in the first case stopped being a fixed window and became a poll:

```ts
const reclaimDeadline = Date.now() + 5_000;
while (activeSqliteOffLoopSlotCountForTesting() !== 0 && Date.now() < reclaimDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
expect(activeSqliteOffLoopSlotCountForTesting()).toBe(0);
```

The reclaim is driven by the execution timer armed when the query started, so a busy host delays
the timer callback and not the reclaim.  Polling for the state with a generous ceiling is the
decidable form of "wait 200ms and hope".

## Verification

- Clean run on a free machine: **26 of 26 passed**, 15.57s, exit 0.
- Under a synthetic load of 30 spinners, at a settled load average of 157 rising to 184, the same
  file passed **26 of 26**.  `main`'s own copy of the file was run back to back at the same load and
  also passed 26 of 26, so the change does not make the file more fragile than it was.
- Mutant, one per assertion.  The mutant makes the execution budget report the timeout without
  retiring the slot, which is the regression both cases are named for:

  ```ts
  // MUTANT: the budget reports the timeout but does not retire the slot.
  for (const pendingWaiter of [...pending.values()]) {
    if (pendingWaiter.slot !== waiter.slot) continue;
    settleReject(pendingWaiter, pendingWaiter.id === waiter.id ? timeoutError : exhausted);
  }
  ```

  Under the mutant the file fails **3 cases of 26**, and both of the cases this change touches fail
  by asserting, not by timing out:

  ```
  FAIL  ... > reclaims a wedged slot after caller abort when the execution budget fires
  AssertionError: expected 1 to be +0
  FAIL  ... > retires a wedged slot when the execution budget fires
  AssertionError: expected 1 to be +0
  ```

  The third failure is the re-dispatch case, which depends on the same retire.
- The mutant was reverted and `src/lib/rag/sqlite-all-offloop.ts` was confirmed byte-identical to
  `HEAD`.
- Mutant, one per assertion, second round.  The first round proved that the retire still happens.
  This round proves that the follow-up assertions are not implied by the assertions before them.
  The mutant retires a slot as soon as a query succeeds:

  ```ts
  if (parsed.data.ok) {
    waiter.resolve(parsed.data.rows);
    // MUTANT: the pool retires the slot as soon as a query succeeds.
    killSlot(slot, () => new Error("sqlite off-loop worker retired"), true);
    return;
  }
  ```

  Under it the follow-up still resolves and the dispatch still happened, so the dispatch assertion
  passes and the live slot count assertion is the one that fires, by asserting and not by timing
  out:

  ```
  FAIL  ... > reclaims a wedged slot after caller abort when the execution budget fires
  AssertionError: expected +0 to be 1
  FAIL  ... > retires a wedged slot when the execution budget fires
  AssertionError: expected +0 to be 1
  ```

  The two failures are the live slot count assertion in each case, and the dispatch assertion on the
  line above it passed in both, which is the proof that the two have different subjects.  The
  mutant also fails the pool-size case and the re-dispatch case, which both expect a live slot
  after a successful query, and that collateral is the same defect seen from two other places.
  The source file was restored byte-identical to `HEAD` afterwards.
- `npm run lint` exits 0 with 867 warnings and 0 errors, `npx tsc --noEmit` exits 0.

## The review round on this change

The automated review opened two findings on the pull request, both on 2026-10-22 at 01:40Z, and both
were taken rather than filed as accepted risk.

The first said the live slot count assertion was redundant, because the count was already 0
immediately beforehand and a query that resolves has to have been served by a live slot, so the count
could only ever be 1.  That is a fair reading of the assertion as it was written, and the answer is
not to argue but to give the case two assertions with different subjects instead of one that its
neighbours already imply.  The dispatch count and the live slot count are now asserted separately,
and the second mutant above is the proof that the slot count assertion can fail on its own.

The second said this note and the ST-4550 note still described the abandoned first design, which
gave the follow-up a deadline of half the wedge.  That was true of the ST-4550 note and it is fixed
there.  This note described the shipped design from the start, but the ST-4550 note did not, and
two notes describing two different designs for one fix is exactly the contradiction the finding is
about.

Two earlier mutants were tried and are recorded because they did not test what they claimed to.
Removing only `slot.disposed = true` from `killSlot` left the file green, because `killSlot` also
splices the slot out of `slots` and the observable counts the array.  Removing the splice as well
left the pool's own reset unable to clean up, which hung the file instead of failing it.  The
mutant above is the one that isolates the behaviour the cases are named for.

## Left alone on purpose

Two other assertions in the same file measure a wall clock, and they are not the reported defect:

```ts
expect(elapsed).toBeGreaterThan(timeoutMs);
expect(elapsed).toBeGreaterThan(wedgeTimeoutMs / 2);
```

Both use the clock as a precondition rather than as the subject.  They prove that a queued request
really did wait before asserting that it was not rejected by the execution budget, and they fail in
the opposite direction from the two that were fixed: the wait has to be long enough, so a fast
machine is the risk and a busy one is the comfort.  Both passed at a settled load of 183 and both
pass on the hosted runner.  One of them failed once during a synthetic load ramp, while the
spinners were still starting, which is a transient this machine manufactured and not a state it
holds.

Replacing them means redesigning the precondition of two cases whose subject is the queue's
timeout semantics, which is a different change from the one the row asks for.  They are recorded
here so the next reader knows they were seen, and why they were left.

## A fixed timeout that is still there

`src/lib/rag/sqlite-all-offloop.ts:1074` arms a 2,000ms timer around the test probe, and the
original failure log showed that timer firing under load.  It is a test-only guard and it is not
part of this change.

## Files

- `test/sqlite-all-offloop.test.ts` — the two wall-clock assertions replaced, and the reclaim wait
  turned into a poll.
- `docs/rollouts/2026-10-21-st-4573-offloop-wall-clock-budget.md` — this note.
- `STATUS.md` — the state entry.
- `PLAN.md` — the scope entry.

# Rollout — ST-4572 suite database follow-ups: the fixture override moves into `beforeAll`, the isolation gets a control assertion, and the teardown stops racing the pending coverage write

## 1. Context & Objective

PR #4912 (ST-4571) merged to `main` as `c0ca9446b` with two follow-ups named in its own "Review Follow-ups" section, and Kody re-raised both as high-severity review threads on the merged pull request at 19:29Z: comment 4341061059 on `test/market-dynamic-universe.test.ts`, "Temporary DATABASE_URL override can leak into later test files", and comment 4341061462 on `test/provenance-stamps.test.ts`, "Database isolation fix lacks a control assertion".  ST-4572 tracks the fix.

Three more Kody threads on the merged PR #4911 (ST-4570) were still unanswered: comment 4339304233, "Bug fix lacks a differential regression test", comment 4339304716, "DATABASE_URL remains overridden until afterAll completes", and comment 4339305193, "afterAll restores the shared DATABASE_URL before pending persists can land".  They name the other half of the fixture work, the two files PR #4911 gave a database to, and they describe the teardown race that the ST-4571 files share with them.  Kody's note on PR #4912 at 4341537498 then prescribed the shape of the control that follows it: the landing row has to be checked against both databases, because checking only the positive case would still pass if the write were duplicated into the shared database as well.

The objective is narrow.  Close the structural hole in the fixture, make the isolation checked rather than assumed, and close the teardown race, without changing the shape that the fire-and-forget persist requires.

## 2. Changes Made

Nine files changed, two of them new.  One production module gains an additive test helper, and no existing assertion was weakened.

- `test/market-dynamic-universe.test.ts` — the `DATABASE_URL` override moves from module scope into `beforeAll`, a control assertion is added, and the teardown waits for the pending coverage write.
- `test/provenance-stamps.test.ts` — the same move, the control assertion checks the URL, the row in this file's own database and the absence of that row in the shared one, and the teardown waits for the pending coverage write.
- `test/enrichment-coverage-persistence.test.ts` — the same move, and the teardown waits for the pending coverage write.
- `test/enrichment-abort.test.ts` — the override moves from module scope into `beforeAll`, and the teardown waits for the pending coverage write.  This is the file PR #4911 gave a database to and the one Kody's comment 4339304716 names.
- `test/enrichment-coverage.test.ts` — the same move, and the same teardown.  Kody's comment 4339304716 names this file as the second site.
- `test/helpers/db-isolation-control.ts` — new.  It exports `sharedDatabasePath(prevDb)`, the path the run shared before a file installed its own, `coverageRowCount(path)`, the number of `enrichment_coverage_runs` rows in the database at an absolute path, and `sharedCoverageRowCount(prevDb)`, the same count for the shared database.  The database is opened READ-ONLY with `fileMustExist: true` and is never created; a database that is not there reads as holding no rows, and a missing table is treated as the same fact, while any other error is rethrown rather than folded into a zero.
- `test/coverage-persist-isolation.test.ts` — new.  A differential test for the teardown race with a control assertion, described below.
- `src/lib/enrichment-coverage.ts` — one additive export, `__awaitPendingEnrichmentCoveragePersist()`, which waits for every coverage persist that is still in flight.  The scheduler now keeps the handle for the write it started, and the handles live on `globalThis` so that a test file calling `vi.resetModules()` cannot orphan a promise that is still pending.  Nothing else in the module changes, and the production behaviour of the persist is unchanged.
- `test/provenance-stamps.test.ts` and `test/market-dynamic-universe.test.ts` — the two files that carry the control now also carry the differential assertion, in their `beforeAll` and ahead of the override.  The control previously observed the environment only after the fixture had installed it, so it passed under the old module-scope implementation as well and could not tell the two apart.  The assertion is `expect(process.env.DATABASE_URL).not.toBe(dbUrl)`: under the old implementation this file's database was already installed when the hook ran, so it fails, and under the new one the run's shared path is still in place, so it passes.  The redundant `not.toBe(prevDb)` line in the control test is gone, since the `toBe(dbUrl)` assertion already implies it.
- `test/helpers/db-isolation-control.ts` — the count row is parsed with a zod schema instead of being read off an untyped row.  The database is a file on disk that another process may have written, so the row is validated at that boundary and a row that does not match is surfaced as a fault rather than folded into a count.  The schema is exported so the validation itself can be proved.
- `test/coverage-persist-isolation.test.ts` — two more cases, one proving the schema accepts the driver's own row and rejects the malformed shapes, and one proving the count on a database that really holds three rows is three, that an empty table is zero, and that a database that is not there is zero without being created.
- `docs/rollouts/2026-10-21-st-4570-suite-db-isolation.md` — corrected in place.  Its decision bullet said that no regression guard was added, which was true when it was written and is false now that this change ships one, so the bullet records that the per-file differential guard exists here and that the repo-level double-run guard it also asks for is the part still open.  The follow-up list carries the same pointer.
- `test/enrichment-abort.test.ts`, `test/enrichment-coverage.test.ts` and `test/enrichment-coverage-persistence.test.ts` — the differential assertion was added to these three as well, so that all five files that restore `DATABASE_URL` carry it.  The assertion had been added only to the two files that also carry a control test, which left the other three able to regress to the module-scope override with no test failing anywhere.  The fixture shape is shared across the five, so the guard belongs to the five.
- `test/helpers/db-isolation-control.ts` — the missing-table match is narrowed to the driver's own error, and the row shape is now checked outside the catch that handles the missing table.  The read moved into an exported `readCountRow(handle)`, so the narrowing can be covered from both sides.  A fault that merely looks like a missing table is a fault, not a zero.
- `test/coverage-persist-isolation.test.ts` — a further case covering that narrowing: the driver's own "no such table" error reads as no rows, and a plain error carrying the same words is surfaced rather than counted as zero.

The control assertion in the two cascade-reaching files carries three parts.  The URL equality proves the file is pointed at its own database.  The row in the file's own database proves the cascade write landed there.  The absence of that row in the shared database proves the write did not land there as well, which is the one condition the first two parts cannot see.  A row landing in the file's own database is consistent with the write also landing in the shared one, and only the second database can tell those two apart.  Kody's note on the merged PR #4912 asked for both halves — that the write lands in this file's own database and not in the shared one — and this is that shape.

The move is the whole of the structural fix.  A module-scope assignment leaves the worker pointed at the file's database for the whole time the module is being evaluated, so a throw between the assignment and the registration of the `afterAll` hook would carry the override into the next file in the worker.  Applying it in `beforeAll` means the environment is only mutated once the file's tests are about to run, and the mutation is always undone by the `afterAll` below it.

The path stays file-scoped.  The persist is a fire-and-forget dynamic import, so it can resolve after the test that triggered it has finished, and a per-test path would hand that late write back to the run's shared database.

Moving the assignment later is safe because it never protected import time in the first place.  ES module imports are evaluated before the importing module's body runs, so the module-scope assignment was already too late to guard an import-time database access.  `src/lib/market.ts` does not import the database module at all, so there is no import-time database access in these files to protect.

The teardown race is the other half.  The persist is scheduled as a fire-and-forget dynamic import, and `persistEnrichmentCoverageReport` resolves the database it writes to when the write lands rather than when it was scheduled, because `getDb()` reads `DATABASE_URL` at that moment.  A teardown that restores `DATABASE_URL` while the write is still in flight therefore has the write land in the database the worker is pointing at by then, which is the shared one.  The teardown of the five files that restore the path now waits for the pending write first, while the file's own database is still the target.

Only those five files restore the path.  The other files that set `DATABASE_URL` leave it installed, so a late write in one of them lands in that file's own database and cannot reach the shared one.  That is what bounds the change, and it is why the teardown fix lands in five files rather than in every file that touches the variable.

## 3. Decisions & Trade-offs

**The suggested remedy was rejected, with a measurement behind it.**  Kody's remedy for 4341061059 is to set the temporary URL in `beforeEach` and restore the prior value in `afterEach`, which is the per-test path.  The per-test path is the shape that was already tried and measured to fail: the ST-4571 rollout note on `main` records that the three files together against a fresh database finish with no `enrichment_coverage_runs` table at all, where a per-test version of the same fix wrote twelve rows in a two-file probe.  Taking the remedy would move the suite back toward the defect ST-4571 fixed.  The concern itself is real and is what this change fixes, by moving the mutation into a hook so that the ordering makes the leak impossible.

**The control assertion is a differential test, and it was proved to fail.**  A control assertion that cannot fail is not a control.  A temporary copy of `test/provenance-stamps.test.ts` with the single override line removed was run against the same database, and the control test failed with the expected message — the active path was the run's shared database rather than the file's own — which is exactly the condition the assertion exists to catch.  The temporary copy was deleted and was never committed.

**The row assertion polls rather than assumes.**  The persist is fire-and-forget, so the coverage row can arrive after the cascade test that triggered it has finished.  The control assertion polls for it for up to five seconds instead of asserting immediately, and the poll itself keeps the file's own database path in force while it waits, which is the property under test.

**The shared database is probed read-only, and never created.**  An earlier revision of this note argued that asserting the shared database does not contain the row would mean opening the shared path from inside the test, and that opening it was the leak this work exists to prevent.  That was right about the effect and wrong about the mechanism.  The leak is a WRITE, and a read-only open with `fileMustExist: true` cannot write anything; the real danger was creating the file, because `better-sqlite3` opens read-write and creates the database by default.  The read-only and `fileMustExist` flags are what make the probe safe, so they are set explicitly rather than relied upon, and a database that is not already there is reported as holding no rows instead of being brought into existence.  With the probe safe, the assertion is worth making, because it is the half that a file-scoped path alone cannot prove.

**The control in the market file sits after the cascade tests, because the cascade write is the thing under test.**  It used to sit at the top of the file's describe block, where it asserted only the URL and so could not fail on a late write.  A control that runs before the write it is meant to check cannot check it, so it moved to the end of the file, where it polls for the cascade row in the file's own database.  The wait is bounded at five seconds, and the file's own database path stays in force for the whole of it, which is the property under test.

**`beforeAll` rather than `beforeEach`.**  The per-test shape is wrong for a writer for the reason given above, and the control assertion is what tells the two apart if the shape ever regresses.  The same shape was applied to the two files Kody named on PR #4911, which still carried the module-scope assignment because PR #4911 predates ST-4571.

**The teardown race is real, and it was reproduced.**  Kody's comment 4339305193 says the teardown restores the shared `DATABASE_URL` while a coverage persist is still pending, and that the pending write then lands in the shared database.  The mechanism is exactly as described.  `persistEnrichmentCoverageReport` calls `getDb()`, and `getDb()` reads `DATABASE_URL` at the moment the write lands.  A probe that scheduled a persist, then restored the path and deleted the file's own directory without awaiting anything, watched the write land 5,745 ms later in the shared database, with the file's own database already deleted and never recreated.  The probe used the production code path and the production teardown ordering; only the module load was forced cold, which is what widened the window.

**The fix waits for the pending write rather than racing it.**  A settle delay would be a guess about how long the write takes, and the module load time is exactly the variable that decides it.  The scheduler now keeps the handle for the write it started, so the teardown can wait for the actual write instead of for a duration.  The handles live on `globalThis` because `vi.resetModules()` replaces the module instance, and a promise held only on the instance would be orphaned while it was still pending.  This is the one production change in the diff, and it is additive: a new export, a handle set, and no change to what the persist does or when it runs.

**The window is closed today by other waits, and the fix is what stops it depending on that.**  The honest position on the five files is that the leak was not observed in them.  In each of them something else already waits for the write to land: the two control tests poll for the coverage row before the teardown runs, the persistence test asserts on the rows, and the abort file's gather aborts before any report is built.  The teardown race therefore depended on how long the database module took to load, and with a warm transform cache that is shorter than the time the file spends in its own tests.  The fix removes the dependency instead of relying on it, which is the difference between a property and an accident.

**The new test carries a control assertion, because a differential test without one proves nothing.**  `test/coverage-persist-isolation.test.ts` holds the ordering down in two halves that differ only in where the wait sits.  The first waits for the pending write before restoring, and asserts that the file's own database holds the row and the shared one holds none.  The second restores first, which is the order the finding names, and asserts that the shared database holds the row.  Without the second half the first would pass whether or not the ordering mattered.  The control is labelled as such, and if it ever stops reproducing then the defect is gone and the control has to be rewritten rather than the first test weakened.

**A control that cannot tell the old fixture from the new one is not a differential, and that was wrong.**  Kody's comments 4342667978 and 4343183247 name the same defect from two angles: the control observed the environment only after the fixture had installed it, so the old module-scope implementation passed it too, and the differential failure Rule 69 asks for was lost.  That is right, and the remedy is taken as stated.  The two control files now assert, ahead of the override and inside their `beforeAll`, that `process.env.DATABASE_URL` is not this file's own path.  Under the old implementation this file's database was already installed when that hook ran, so the assertion fails and the old implementation is caught there; under the new one the run's shared path is still in place, so it passes.  The assertion was proved to fire by running a copy of `test/provenance-stamps.test.ts` with the override moved back to module scope, which failed at that assertion with the two paths printed side by side, and the ten tests in that file skipped behind it.

**The collection-time claim was checked and does not hold.**  Kody's comment 4342668377 says that moving the override out of module scope means collection-time reads capture the shared path, and that the nested blocks then restore it and send the rest of the file back to the run's shared database.  Both halves were checked in the code rather than argued.  The path is never captured at module scope: `databasePath()` is a function, `getDb()` is a lazy singleton that calls it, and none of the modules these files import — `src/lib/data-providers.ts`, `src/lib/db-enrichment-coverage.ts`, `src/lib/evidence-facts.ts`, `src/lib/history.ts`, `src/lib/market.ts` — calls it at module scope, so an import that happens at collection time still reads the variable when the database is opened.  And the nested blocks cannot restore the shared path, because they capture `prevDb` inside the test body, which runs after the file's `beforeAll` has installed this file's path; what they capture is this file's own path and what they restore is this file's own path.  The concern was answered with the evidence rather than taken, and the reply on the thread carries the same evidence.

**The row from the database is validated, because a file on disk is an untrusted input.**  Kody's comment 4343182962 says the count row is read off an untyped result before any schema check, so an unexpected database shape could corrupt the count.  That is right, and the row is now parsed with a zod schema at that boundary.  A row that does not match is surfaced as a fault rather than folded into a count, which keeps the file's existing rule that an unexpected database error is never silently a zero.

**The missing table is recognised by the driver's own error, not by a string in a message.**  The row shape is now checked outside the catch that handles the missing table, and that catch matches on `err instanceof Database.SqliteError` as well as on the message.  Before this, the catch matched `/no such table/i` on any `Error`, so the shape fault was routed through it: correct today, because a zod message never contains that string, and wrong the day one does, because a real fault would then be read as a zero.  That is the failure mode this helper exists to prevent, so the two cases are separated rather than left to a message.

**The differential assertion covers all five files, not the two that happen to carry a control test.**  The assertion was added to the two files with a control test, and the other three files that restore `DATABASE_URL` did not get it.  Those three could have regressed to the module-scope override with no test failing anywhere in the suite, which is the same class of gap the assertion exists to close.  The fixture shape is shared across the five files, so the guard belongs to the five, and the assertion is now in all of them.

**The schema stays non-strict, because the helper wants the count and not the row.**  A strict schema would reject a row carrying extra columns.  The count query selects one column, and a future widening of that query would add columns to the row, which is a change to the query rather than a fault in the database.  A non-strict schema strips what the helper does not need and keeps the count.  The count is the fact this helper exists to report, so losing a column the helper never read is the wrong thing to fail on.

## 4. Verification State

- `npx tsc --noEmit` exits 0.
- `npx eslint` over the seven changed files exits 0.  One pre-existing warning is left in place, an `any` in a body this change does not touch.
- The three changed files, run together against a fresh database: 17 tests passed, up from 15, the two new ones being the control assertions.
- The negative control described above fails as it must, with the active path reported as the shared database.
- The six files this diff touches, run together against a fresh database: 45 tests passed across 6 files, and the checkout's `data/app.db` was absent afterwards.  The count is the one after the third round below; the earlier rounds measured 42 and 44.
- `test/coverage-persist-isolation.test.ts`: 2 tests passed, which is the ordering that waits for the pending write and the control that restores first.

### The teardown race, measured

- The race reproduces in isolation.  A probe that scheduled a coverage persist through the production path and then ran the production teardown ordering, a restore of `DATABASE_URL` followed by the removal of the file's own directory with nothing awaited in between, watched the write land 5,745 ms later in the shared database.  The file's own database was deleted and never recreated, and the shared database held one coverage row where it had held none.  The probe was deleted and was never committed.
- The fix removes the window.  `test/provenance-stamps.test.ts`, `test/market-dynamic-universe.test.ts` and `test/enrichment-coverage.test.ts` were each run against a seeded shared database, once with the wait in the teardown and once with it removed.  Every run left the shared database at zero rows.
- The window is closed today by something else in each of those files.  The two control tests poll for the coverage row before the teardown runs, and the persistence test asserts on the rows, so the write has already landed by the time the teardown runs.  That is why the leak was not observed in the files themselves, and it is a property of their current shape rather than of the teardown.  The teardown no longer depends on it.

### The new assertion was proved non-vacuous, in three parts

The assertion `expect(sharedCoverageRowCount(prevDb)).toBe(0)` is worth making only if the counter can return a non-zero number, and it catches the leak only if the leak really reaches the shared database.  Each of those was measured on its own, with temporary files that were deleted and never committed.

1.  **The counter counts what is really there.**  A database holding the real `enrichment_coverage_runs` table and three rows was counted as three.  A database holding the table and no rows was counted as zero, and a database that was not there was counted as zero without the helper creating it.  Three tests, three passes.
2.  **The leak really reaches the shared database.**  A temporary copy of `test/provenance-stamps.test.ts` with the single override line removed was run against a seeded shared database that held no rows.  The control test failed on the URL assertion, reporting the run's shared database as the active path, and the shared database held one coverage row afterwards where it held none before.  That is the real leak, observed rather than assumed.
3.  **The new assertion fires on exactly that state.**  The unmodified `test/provenance-stamps.test.ts` was run against a shared database seeded with one coverage row.  The URL assertions passed, the cascade row was found in the file's own database, and the new assertion failed with `expected 1 to be +0`, the counter reporting the row sitting in the shared database.

Together those three are the proof that the assertion is not a tautology.  The first rules out a counter that always reads zero, the second rules out a leak that never happens, and the third shows the assertion firing on the real condition.

The full-suite criterion is the same one ST-4571 set, re-run against the changed fixture: a full `npx vitest run` against a database that did not exist when the suite started must leave zero rows in `enrichment_coverage_runs` and must not leave a `data/app.db` in the checkout.  The run was `DATABASE_URL="file:/tmp/mm-st4572-full.db" npx vitest run` with the checkout's `data/app.db` removed beforehand, and it reported 861 files, 859 passed, 1 failed, 1 skipped; 9749 tests, 9697 passed, 1 failed, 51 skipped; 2,705 s.  The suite exited 1, and the single failure is `test/event-loop-stall-hot-path.test.ts`, the same case that fails on `main` for the same host-load reason and that this diff does not touch.  After the run the shared database held 0 enrichment coverage rows, where the same full run left four rows before the ST-4571 fix, and the checkout's `data/app.db` was absent (good).  That run measured the fixture as it stood before the teardown change; the hosted `verify-hosted` job is the gate of record for the whole suite on this diff.

One production module changed, additively.  `src/lib/enrichment-coverage.ts` gains the pending-write handle and the `__awaitPendingEnrichmentCoveragePersist()` export, and the persist itself is untouched: it is still scheduled as a fire-and-forget dynamic import, it still writes when it lands, and it still swallows its own failures.  Nothing in the app's behaviour changes, because the only caller of the new export is a test teardown.

### The second review round, measured

A second review round on this pull request raised four findings against the control and the helper.  Three of them changed code and are measured here; the fourth was checked against the code and answered on its thread.

- **The differential assertion fires under the old fixture.**  A copy of `test/provenance-stamps.test.ts` with the override moved back to module scope and the new assertion left in place was run against a fresh shared database.  It failed at that assertion with the two paths printed side by side, and the ten tests in the file were skipped behind it.  The probe file was removed and never committed.
- **The same files pass with the new fixture.**  The six files this diff touches were run together against a fresh database: 44 tests passed, 44 of 44, and the shared database the run inherited was still absent afterwards, so nothing escaped into it.
- **The schema accepts the driver's own row and rejects the malformed ones.**  The exported schema accepts `{ n: 3 }` and `{ n: 0 }`, and rejects `{ n: "3" }`, `{ n: -1 }`, `{ n: 1.5 }`, `{ count: 3 }`, `undefined` and `null`.  The count on a database that really holds three rows is three, an empty table is zero, and a database that is not there is zero without being created.
- **The collection-time claim was checked in the source.**  `databasePath()` is a function and `getDb()` is a lazy singleton that calls it; none of `src/lib/data-providers.ts`, `src/lib/db-enrichment-coverage.ts`, `src/lib/evidence-facts.ts`, `src/lib/history.ts` or `src/lib/market.ts` calls it at module scope.  The nested blocks in `test/provenance-stamps.test.ts` capture the previous path inside the test body, which runs after the file's `beforeAll` has installed this file's path, so what they restore is this file's own path and not the run's shared one.
- `npx tsc --noEmit` exits 0 after the round.  `npx eslint` over the four files this round touched exits 0, with the same one pre-existing `any` warning in `test/provenance-stamps.test.ts` and nothing new.

### The third review round, measured

A third round raised no new findings against the change, but two of the notes on it were worth acting on, and one of them named a real latent defect in code this branch had just added.

- **The narrowed catch is proved from both sides.**  The helper's catch was reverted to its earlier form, which matched `/no such table/i` on any `Error`, and the new case failed with `expected [Function] to throw an error`: the plain fault had been swallowed and read as zero.  With the catch narrowed to `err instanceof Database.SqliteError`, the driver's own missing-table error reads as no rows and the plain error is surfaced.  The helper was restored immediately afterwards and the narrowing is what is committed.
- **The differential assertion fires in the newly guarded files too.**  A temporary copy of `test/enrichment-abort.test.ts` with the override moved back to module scope failed at the new assertion with the two paths printed side by side, and the two tests in the file skipped behind it.  The probe file was removed and was never committed.
- **The six test files this diff touches pass together.**  45 tests passed across 6 files against a fresh database, and the checkout's `data/app.db` was absent afterwards.
- `npx tsc --noEmit` exits 0 after the round.  `npx eslint` over the seven files this round touched exits 0, with the same one pre-existing `any` warning in `test/provenance-stamps.test.ts` and nothing new.

### The fourth review round, measured

A fourth round raised three findings against this pull request.  One of them named a real defect in
code this branch had just added, one of them was answered with a measurement that the regression
test does bite against the pre-fix code, and one of them was checked against the source and
answered.

- **The capture of the shared path moved to module scope.**  The differential assertion was the
  first statement of `beforeAll`, ahead of `prevDb = process.env.DATABASE_URL`, so an assertion
  that failed left the capture unset.  The teardown then read that unset capture as "the run had
  no `DATABASE_URL`" and deleted the variable instead of restoring it, which is the opposite of
  what the teardown is for.  The capture is now a module-scope constant in all five files, where
  no hook can skip it, and the teardown always restores a value that was really there.

  Measured from both sides with a miniature of the fixture, because the defect lives in the order
  of two statements.  With a shared path in place and the differential assertion failing, the new
  shape left the teardown holding the shared path, and the pre-fix shape left it holding nothing,
  because the variable had been deleted.  The probe was removed and was never committed.
- **The shape is now pinned.**  `test/db-isolation-fixture-shape.test.ts` is a new guard over the
  five fixtures: the capture is a module-scope constant, no hook takes a second capture, the
  differential assertion is in the hook and ahead of the override, and the teardown restores.
  Against the pre-fix shape the guard fails and reports the capture's absence, so it bites on the
  thing it is there to catch.
- **The regression test does fail against the pre-fix code.**  The claim was that
  `test/coverage-persist-isolation.test.ts` calls the persistence helper directly and so passes
  against the pre-fix implementation.  `__awaitPendingEnrichmentCoveragePersist` was turned into
  the no-op the pre-fix code amounted to, and the file's first test failed with `expected +0 to be
  1`: the row had not landed in the file's own database, because nothing waited for the write.
  The helper was restored immediately afterwards.  The suggested placement for the differential
  assertion, before the override is applied, is where it already is, in the `beforeAll` of the
  five files that apply the override.  This file applies no override; it manages two databases of
  its own inside its temporary directory, so there is no override for an assertion to precede.
- **The persist is synchronous, so the tracked promise cannot settle early.**  The finding was
  that the `.then` callback invokes `persistEnrichmentCoverageReport(report)` without returning
  it, so the await helper can resolve while the write is still running.
  `persistEnrichmentCoverageReport` resolves the database, opens the handle and writes the rows
  inside a better-sqlite3 transaction, and returns `void`, so the write has landed by the time
  the callback returns and the tracked promise settles only after it.  The asynchronous part is
  the dynamic import, and that is what makes the tracked promise worth awaiting.  The comment in
  the module now says so.
- **A comment in the five fixtures was wrong, and it is corrected.**  It claimed that a
  module-scope override would carry into the next file in the worker.  A two-file probe measured
  the process id of each file and the two ids differed, so each test file runs in its own process
  and a mutation of `process.env` in one file does not reach the next one.  The comment now says
  what the module-scope arrangement actually does, which is open the window in which the
  environment points at this file's database before the teardown that closes it is registered.
- **The seven files this diff touches pass together.**  56 tests passed across 7 files against a
  fresh database, and the checkout's `data/app.db` was absent afterwards.
- `npx tsc --noEmit` exits 0 after the round.  `npx eslint` over the seven files this round
  touched exits 0, with the same one pre-existing `any` warning in `test/provenance-stamps.test.ts`
  and nothing new.

## 5. Next Steps & Blockers

None outstanding for the fix itself.  The follow-up comment on PR #4912 and the three threads on PR #4911 are answered with the measurement, the reproduction and the fix, and resolved.  The five review threads on this pull request are answered the same way: three of them changed code and are measured above, and the one about collection-time capture was checked in the source and answered with the evidence.  A third round raised no new findings and confirmed all five; two of its notes were acted on rather than acknowledged, and both are measured in the third round section.  A fourth round raised three more, and all three are answered on their threads: one of them named a real defect in this branch's own fixture, which is fixed and measured in the fourth round section, one was answered with a measurement that the regression test does bite against the pre-fix code, and one was checked against the source and answered.  The repository-level guard that ST-4571 deliberately left out — asserting after the suite that the database it ran against collected no coverage rows — is still out of scope for a test-file change and is still recorded as a follow-up on ST-4571.

What this change does add is the file-level half of that guard.  Each cascade-reaching file now asserts that the shared database it inherited holds no coverage row when its own tests finish, which is the same fact the repo-level guard would assert, taken per file rather than once at the end of the run.

## 6. Zero-Code Findings

None.  The change is confined to the test fixture and to the one production module that fixture already reached into, and that module gains only an additive export for a test teardown to await.  No behaviour outside the test suite is affected.

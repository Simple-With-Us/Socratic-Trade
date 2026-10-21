# Rollout — ST-4572 suite database follow-ups: the fixture override moves into `beforeAll`, and the isolation gets a control assertion

## 1. Context & Objective

PR #4912 (ST-4571) merged to `main` as `c0ca9446b` with two follow-ups named in its own "Review Follow-ups" section, and Kody re-raised both as high-severity review threads on the merged pull request at 19:29Z: comment 4341061059 on `test/market-dynamic-universe.test.ts`, "Temporary DATABASE_URL override can leak into later test files", and comment 4341061462 on `test/provenance-stamps.test.ts`, "Database isolation fix lacks a control assertion".  ST-4572 tracks the fix.

The objective is narrow.  Close the structural hole in the fixture, and make the isolation checked rather than assumed, without changing the shape that the fire-and-forget persist requires.

## 2. Changes Made

Three test files changed and one helper module added.  No production code changed, and no existing assertion was weakened.

- `test/market-dynamic-universe.test.ts` — the `DATABASE_URL` override moves from module scope into `beforeAll`, and a control assertion is added.
- `test/provenance-stamps.test.ts` — the same move, and the control assertion checks both the URL and that the cascade coverage row landed in this file's own database.
- `test/enrichment-coverage-persistence.test.ts` — the same move.
- `test/helpers/db-isolation-control.ts` — new.  It exports `sharedDatabasePath(prevDb)`, the path the run shared before a file installed its own, and `sharedCoverageRowCount(prevDb)`, the number of `enrichment_coverage_runs` rows in that shared database.  The shared database is opened READ-ONLY with `fileMustExist: true` and is never created; a database that is not there reads as holding no rows, and a missing table is treated as the same fact, while any other error is rethrown rather than folded into a zero.

The control assertion in the two cascade-reaching files carries three parts.  The URL equality proves the file is pointed at its own database.  The row in the file's own database proves the cascade write landed there.  The absence of that row in the shared database proves the write did not land there as well, which is the one condition the first two parts cannot see.  A row landing in the file's own database is consistent with the write also landing in the shared one, and only the second database can tell those two apart.  Kody's note on the merged PR #4912 asked for both halves — that the write lands in this file's own database and not in the shared one — and this is that shape.

The move is the whole of the structural fix.  A module-scope assignment leaves the worker pointed at the file's database for the whole time the module is being evaluated, so a throw between the assignment and the registration of the `afterAll` hook would carry the override into the next file in the worker.  Applying it in `beforeAll` means the environment is only mutated once the file's tests are about to run, and the mutation is always undone by the `afterAll` below it.

The path stays file-scoped.  The persist is a fire-and-forget dynamic import, so it can resolve after the test that triggered it has finished, and a per-test path would hand that late write back to the run's shared database.

Moving the assignment later is safe because it never protected import time in the first place.  ES module imports are evaluated before the importing module's body runs, so the module-scope assignment was already too late to guard an import-time database access.  `src/lib/market.ts` does not import the database module at all, so there is no import-time database access in these files to protect.

## 3. Decisions & Trade-offs

**The suggested remedy was rejected, with a measurement behind it.**  Kody's remedy for 4341061059 is to set the temporary URL in `beforeEach` and restore the prior value in `afterEach`, which is the per-test path.  The per-test path is the shape that was already tried and measured to fail: the ST-4571 rollout note on `main` records that the three files together against a fresh database finish with no `enrichment_coverage_runs` table at all, where a per-test version of the same fix wrote twelve rows in a two-file probe.  Taking the remedy would move the suite back toward the defect ST-4571 fixed.  The concern itself is real and is what this change fixes, by moving the mutation into a hook so that the ordering makes the leak impossible.

**The control assertion is a differential test, and it was proved to fail.**  A control assertion that cannot fail is not a control.  A temporary copy of `test/provenance-stamps.test.ts` with the single override line removed was run against the same database, and the control test failed with the expected message — the active path was the run's shared database rather than the file's own — which is exactly the condition the assertion exists to catch.  The temporary copy was deleted and was never committed.

**The row assertion polls rather than assumes.**  The persist is fire-and-forget, so the coverage row can arrive after the cascade test that triggered it has finished.  The control assertion polls for it for up to five seconds instead of asserting immediately, and the poll itself keeps the file's own database path in force while it waits, which is the property under test.

**The shared database is probed read-only, and never created.**  An earlier revision of this note argued that asserting the shared database does not contain the row would mean opening the shared path from inside the test, and that opening it was the leak this work exists to prevent.  That was right about the effect and wrong about the mechanism.  The leak is a WRITE, and a read-only open with `fileMustExist: true` cannot write anything; the real danger was creating the file, because `better-sqlite3` opens read-write and creates the database by default.  The read-only and `fileMustExist` flags are what make the probe safe, so they are set explicitly rather than relied upon, and a database that is not already there is reported as holding no rows instead of being brought into existence.  With the probe safe, the assertion is worth making, because it is the half that a file-scoped path alone cannot prove.

**The control in the market file sits after the cascade tests, because the cascade write is the thing under test.**  It used to sit at the top of the file's describe block, where it asserted only the URL and so could not fail on a late write.  A control that runs before the write it is meant to check cannot check it, so it moved to the end of the file, where it polls for the cascade row in the file's own database.  The wait is bounded at five seconds, and the file's own database path stays in force for the whole of it, which is the property under test.

**`beforeAll` rather than `beforeEach`.**  The per-test shape is wrong for a writer for the reason given above, and the control assertion is what tells the two apart if the shape ever regresses.

## 4. Verification State

- `npx tsc --noEmit` exits 0.
- `npx eslint` over the three changed files exits 0.  One pre-existing warning is left in place, an `any` in a body this change does not touch.
- The three changed files, run together against a fresh database: 17 tests passed, up from 15, the two new ones being the control assertions.
- The negative control described above fails as it must, with the active path reported as the shared database.

### The new assertion was proved non-vacuous, in three parts

The assertion `expect(sharedCoverageRowCount(prevDb)).toBe(0)` is worth making only if the counter can return a non-zero number, and it catches the leak only if the leak really reaches the shared database.  Each of those was measured on its own, with temporary files that were deleted and never committed.

1.  **The counter counts what is really there.**  A database holding the real `enrichment_coverage_runs` table and three rows was counted as three.  A database holding the table and no rows was counted as zero, and a database that was not there was counted as zero without the helper creating it.  Three tests, three passes.
2.  **The leak really reaches the shared database.**  A temporary copy of `test/provenance-stamps.test.ts` with the single override line removed was run against a seeded shared database that held no rows.  The control test failed on the URL assertion, reporting the run's shared database as the active path, and the shared database held one coverage row afterwards where it held none before.  That is the real leak, observed rather than assumed.
3.  **The new assertion fires on exactly that state.**  The unmodified `test/provenance-stamps.test.ts` was run against a shared database seeded with one coverage row.  The URL assertions passed, the cascade row was found in the file's own database, and the new assertion failed with `expected 1 to be +0`, the counter reporting the row sitting in the shared database.

Together those three are the proof that the assertion is not a tautology.  The first rules out a counter that always reads zero, the second rules out a leak that never happens, and the third shows the assertion firing on the real condition.

The full-suite criterion is the same one ST-4571 set, re-run against the changed fixture: a full `npx vitest run` against a database that did not exist when the suite started must leave zero rows in `enrichment_coverage_runs` and must not leave a `data/app.db` in the checkout.  The run was `DATABASE_URL="file:/tmp/mm-st4572-full.db" npx vitest run` with the checkout's `data/app.db` removed beforehand, and it reported 861 files, 859 passed, 1 failed, 1 skipped; 9749 tests, 9697 passed, 1 failed, 51 skipped; 2,705 s.  The suite exited 1, and the single failure is `test/event-loop-stall-hot-path.test.ts`, the same case that fails on `main` for the same host-load reason and that this diff does not touch.  After the run the shared database held 0 enrichment coverage rows, where the same full run left four rows before the ST-4571 fix, and the checkout's `data/app.db` was absent (good).

No production code changed, so the diff cannot change what the app does.

## 5. Next Steps & Blockers

None outstanding for the fix itself.  The two review threads on PR #4912 were answered with the measurement and resolved.  The repository-level guard that ST-4571 deliberately left out — asserting after the suite that the database it ran against collected no coverage rows — is still out of scope for a test-file change and is still recorded as a follow-up on ST-4571.

What this change does add is the file-level half of that guard.  Each cascade-reaching file now asserts that the shared database it inherited holds no coverage row when its own tests finish, which is the same fact the repo-level guard would assert, taken per file rather than once at the end of the run.

## 6. Zero-Code Findings

Not applicable.  This change is test-only, and the code it touches is the test fixture that the previous change introduced.

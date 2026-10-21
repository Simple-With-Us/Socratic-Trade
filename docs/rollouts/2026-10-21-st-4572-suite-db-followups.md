# Rollout — ST-4572 suite database follow-ups: the fixture override moves into `beforeAll`, and the isolation gets a control assertion

## 1. Context & Objective

PR #4912 (ST-4571) merged to `main` as `c0ca9446b` with two follow-ups named in its own "Review Follow-ups" section, and Kody re-raised both as high-severity review threads on the merged pull request at 19:29Z: comment 4341061059 on `test/market-dynamic-universe.test.ts`, "Temporary DATABASE_URL override can leak into later test files", and comment 4341061462 on `test/provenance-stamps.test.ts`, "Database isolation fix lacks a control assertion".  ST-4572 tracks the fix.

The objective is narrow.  Close the structural hole in the fixture, and make the isolation checked rather than assumed, without changing the shape that the fire-and-forget persist requires.

## 2. Changes Made

Three test files changed.  No production code changed, and no existing assertion was weakened.

- `test/market-dynamic-universe.test.ts` — the `DATABASE_URL` override moves from module scope into `beforeAll`, and a control assertion is added.
- `test/provenance-stamps.test.ts` — the same move, and the control assertion checks both the URL and that the cascade coverage row landed in this file's own database.
- `test/enrichment-coverage-persistence.test.ts` — the same move.

The move is the whole of the structural fix.  A module-scope assignment leaves the worker pointed at the file's database for the whole time the module is being evaluated, so a throw between the assignment and the registration of the `afterAll` hook would carry the override into the next file in the worker.  Applying it in `beforeAll` means the environment is only mutated once the file's tests are about to run, and the mutation is always undone by the `afterAll` below it.

The path stays file-scoped.  The persist is a fire-and-forget dynamic import, so it can resolve after the test that triggered it has finished, and a per-test path would hand that late write back to the run's shared database.

Moving the assignment later is safe because it never protected import time in the first place.  ES module imports are evaluated before the importing module's body runs, so the module-scope assignment was already too late to guard an import-time database access.  `src/lib/market.ts` does not import the database module at all, so there is no import-time database access in these files to protect.

## 3. Decisions & Trade-offs

**The suggested remedy was rejected, with a measurement behind it.**  Kody's remedy for 4341061059 is to set the temporary URL in `beforeEach` and restore the prior value in `afterEach`, which is the per-test path.  The per-test path is the shape that was already tried and measured to fail: the ST-4571 rollout note on `main` records that the three files together against a fresh database finish with no `enrichment_coverage_runs` table at all, where a per-test version of the same fix wrote twelve rows in a two-file probe.  Taking the remedy would move the suite back toward the defect ST-4571 fixed.  The concern itself is real and is what this change fixes, by moving the mutation into a hook so that the ordering makes the leak impossible.

**The control assertion is a differential test, and it was proved to fail.**  A control assertion that cannot fail is not a control.  A temporary copy of `test/provenance-stamps.test.ts` with the single override line removed was run against the same database, and the control test failed with the expected message — the active path was the run's shared database rather than the file's own — which is exactly the condition the assertion exists to catch.  The temporary copy was deleted and was never committed.

**The row assertion polls rather than assumes.**  The persist is fire-and-forget, so the coverage row can arrive after the cascade test that triggered it has finished.  The control assertion polls for it for up to five seconds instead of asserting immediately, and the poll itself keeps the file's own database path in force while it waits, which is the property under test.

**The row assertion reads only the file's own database.**  Asserting that the shared database does not contain the row would mean opening the shared path from inside the test, which is the leak this work exists to prevent.  The isolation is asserted on the path instead, and the row is asserted on the file's own database.

**`beforeAll` rather than `beforeEach`.**  The per-test shape is wrong for a writer for the reason given above, and the control assertion is what tells the two apart if the shape ever regresses.

## 4. Verification State

- `npx tsc --noEmit` exits 0.
- `npx eslint` over the three changed files exits 0.  One pre-existing warning is left in place, an `any` in a body this change does not touch.
- The three changed files, run together against a fresh database: 17 tests passed, up from 15, the two new ones being the control assertions.
- The negative control described above fails as it must, with the active path reported as the shared database.

The full-suite criterion is the same one ST-4571 set, re-run against the changed fixture: a full `npx vitest run` against a database that did not exist when the suite started must leave zero rows in `enrichment_coverage_runs` and must not leave a `data/app.db` in the checkout.  The run was `DATABASE_URL="file:/tmp/mm-st4572-full.db" npx vitest run` with the checkout's `data/app.db` removed beforehand, and it reported 861 files, 859 passed, 1 failed, 1 skipped; 9749 tests, 9697 passed, 1 failed, 51 skipped; 2,705 s.  The suite exited 1, and the single failure is `test/event-loop-stall-hot-path.test.ts`, the same case that fails on `main` for the same host-load reason and that this diff does not touch.  After the run the shared database held 0 enrichment coverage rows, where the same full run left four rows before the ST-4571 fix, and the checkout's `data/app.db` was absent (good).

No production code changed, so the diff cannot change what the app does.

## 5. Next Steps & Blockers

None outstanding for the fix itself.  The two review threads on PR #4912 were answered with the measurement and resolved.  The repository-level guard that ST-4571 deliberately left out — asserting after the suite that the database it ran against collected no coverage rows — is still out of scope for a test-file change and is still recorded as a follow-up on ST-4571.

## 6. Zero-Code Findings

Not applicable.  This change is test-only, and the code it touches is the test fixture that the previous change introduced.

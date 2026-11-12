# 2026-10-21 - st-4571-suite-db-hygiene

## Summary

- The local vitest suite no longer leaves enrichment coverage rows in the run's shared database, and
  no test file clears the run's database path any more.
- ST-4571, filed as the residual of ST-4570, is closed by three test files and no production change.

## Why

- ST-4570 fixed the reported defect: the reader in `test/data-catalog-completeness.test.ts` now
  owns its database, so its empty-universe premise is true by construction rather than by run
  order.  That fix was merged and closed.
- The residual was named rather than glossed over.  A full local run still left four enrichment
  coverage rows in the run's shared database, and one test file cleared the run's database path
  outright.
- The first account of the residual inferred the source from the row payloads, which carry the
  `ask` and `analystRating` fields, and concluded that provider tests were responsible.  That
  inference was wrong.  Running each candidate file on its own against a fresh database and
  counting the rows names the two offenders exactly, and neither is a provider test.

## How the two offenders were named

The method that settles it is isolation, not inference.  The full run left four rows.  Running the
candidate files one at a time against a fresh database produced exactly those four rows, split
three and one:

- `test/market-dynamic-universe.test.ts` — three rows.  It calls `scanMarket()`, which calls
  `getEnrichmentProvider()` and then `provider.enrich()`.  Every cascade gather builds an
  enrichment coverage report and persists it, so this file reached the persistence path without
  owning a database.
- `test/provenance-stamps.test.ts` — one row.  Its "cascade merge arbitrates the new quote
  fields" case constructs a `CascadingEnrichmentProvider` directly and calls `enrich()` on it.

Neither file owned a database, so their rows landed in whatever database was current.  The
thirteen provider files that had been suspected wrote no rows at all.

## The two routes, and the one that is worse than it looks

- **No database of its own.**  Both files now point `DATABASE_URL` at their own temporary SQLite
  database and hold that path for the whole file, which is the shape ST-4570 established: the
  persist is a fire-and-forget dynamic import, so it can resolve after the test that triggered it
  has finished, and a per-test path would hand that late write back to the shared database.
- **Clearing the run's path.**  `test/enrichment-coverage-persistence.test.ts` deleted
  `process.env.DATABASE_URL` in its cleanup.  Deleting is worse than never setting: the reader
  falls back to a default when the variable is unset, and that default is the checkout's own
  `file:./data/app.db`, so a late persist that resolves after the delete reopens the connection on
  the checkout's own application database rather than on the run's.  The file now saves the run's
  path and restores it.

## Files

- `test/market-dynamic-universe.test.ts` — owns a database for the whole file, and restores the
  run's path afterwards.
- `test/provenance-stamps.test.ts` — same.  Its own per-block databases now save and restore this
  file's path, so their rows stay with them.
- `test/enrichment-coverage-persistence.test.ts` — saves and restores the run's path instead of
  deleting it, and holds one path for the whole file.  Each test clears the coverage store first,
  so the run counts it asserts are its own runs.
- `docs/rollouts/2026-10-21-st-4571-suite-db-hygiene.md` — this note.
- `STATUS.md`, `PLAN.md` — the record of this effort.

## Verification

- `npx tsc --noEmit` — exit 0.
- `npx eslint test/enrichment-coverage-persistence.test.ts test/market-dynamic-universe.test.ts
  test/provenance-stamps.test.ts` — exit 0, with one pre-existing warning left in place
  (`test/provenance-stamps.test.ts:206`, an `any` in a test body this change does not touch).
  Three pre-existing unused-import warnings on lines this change already edits are gone.
- The three changed files, run together against a fresh database: 15 tests passed, and the
  database finished with **no `enrichment_coverage_runs` table at all**, where the same probe
  wrote **4** rows before the change.
- The three files run one at a time against a fresh database: `market-dynamic-universe` wrote
  **3** rows and `provenance-stamps` wrote **1**, which is exactly the residual the full run
  produced.
- **The full suite, which is the criterion the issue names.**  `DATABASE_URL="file:/tmp/mm-st4571-full.db"
  npx vitest run`, with the checkout's `data/app.db` removed before the run: 861 files, 859
  passed, 1 failed, 1 skipped; 9,747 tests, 9,695 passed, 51 skipped, 1 failed; 2,634 s.  The
  single failure is `test/event-loop-stall-hot-path.test.ts`, the serving-thread sqlite stall case,
  which timed out at the 60 s limit on this Mac and fails the same way on `main` for the same
  host-load reason; it is not related to this change.  After the run the shared database held
  **0** enrichment coverage rows in `enrichment_coverage_runs`, where the same full run left **4**
  rows before the change, and the checkout's `data/app.db` was **absent**.

## Decisions & Trade-offs

- **Test-only, no production change.**  A guard in `src/lib/enrichment-coverage.ts` would stop the
  leak at the source, but `test/enrichment-coverage-persistence.test.ts` asserts that persistence
  does happen, so such a guard would break a test that is asserting the intended behaviour.
  Isolating the database per file is what the repo already does everywhere else.
- **One path for the whole file, and a per-test clear for the counts.**  The writer rule from
  ST-4570 is kept: the path is held for the whole file.  The persistence file needed its run
  counts to be its own, so it clears the coverage store in `beforeEach` rather than owning a
  separate database per test.  The fire-and-forget write from the previous test has resolved by
  then: the test awaits it before it ends.
- **The unused imports on the touched lines were removed.**  Three `no-unused-vars` warnings sat on
  import lines this change already rewrites.  Leaving them would have meant editing a line and
  keeping a warning it could have gone with.
- **Kept off the public-pages branch.**  The fix is on its own branch off `origin/main`, so it does
  not widen the diff of PR #4889 and it carries no unattributed commit, so it needs no owner
  approval to land.
- **No repo-level guard was added here.**  The guard that would keep this class from returning is
  a check on the suite's own database after the run, which belongs with the repo's gate rather
  than with a test-file change.  It is recorded as a follow-up on ST-4571.

## Follow-ups

- Add the repo-level guard: assert after the suite that the database it ran against collected no
  enrichment coverage rows, and that no application database was left in the checkout.  That is the
  property that was broken, and the per-file fix does not assert it.
- 450 of the 458 test files that own a database set `DATABASE_URL` and never restore it.  That is
  untidy rather than a leak, because each of those paths points at a database that belongs to the
  file that set it, but it does mean the run's shared database is not a stable identity, which is
  why the rows had to be attributed by isolation rather than by reading the shared path.

## Zero-Code Findings

- `databasePath()` falls back to `file:./data/app.db` when `DATABASE_URL` is unset, so an unset
  variable is not "no database" but "the checkout's own application database".  Any cleanup that
  deletes the variable is handing the next file that database.
- `buildEnrichmentCoverageReport` is called from exactly one place, the cascade's `enrich()` in
  `src/lib/data-providers.ts`, and `scanMarket()` reaches that cascade through
  `getEnrichmentProvider()`.  A test that calls `scanMarket()` therefore reaches the persistence
  path without mentioning the cascade at all, which is why the first account of the residual
  looked in the wrong files.

# 2026-10-21 - st-4570-suite-db-isolation

## Summary

- The local vitest suite no longer writes enrichment coverage rows into the checkout's own
  untracked `data/app.db`, and `test/data-catalog-completeness.test.ts` now passes whatever order
  the test files happen to run in.

## Why

- ST-4570, raised from P2 to P1 while this fix was in flight.  The reader asserts an empty-database
  universe, but `buildDataCompletenessReport` reads the newest persisted enrichment coverage report
  back and uses its `fillRate` as a field's `completeness` whenever one exists.  The suite's own
  writers create that report, so the reader's premise was decided by run order rather than by
  anything about the code under test.
- The first account of the failure said the residue of earlier runs was the trigger and that hosted
  CI could not see it at all.  A third full pass, run against a database that did not exist when the
  suite started, falsified that: the same test failed again, and the new file had collected
  seventeen coverage rows by the end of that one run.  The defect is a within-run ordering flake
  that a clean checkout can hit.
- The repo already has the convention that settles it.  `test/reindex-all.test.ts:8` states it in
  as many words — every test file points `DATABASE_URL` at its own temporary SQLite database — and
  458 of the 854 test files do.  Three files that can reach the persistence path did not, and they
  are the ones changed here.

## Files

- `test/data-catalog-completeness.test.ts` — the reader.  It now owns its database, so its
  empty-universe premise is true by construction.
- `test/enrichment-coverage.test.ts` — the writer.  It now owns its database, and holds that path
  for the whole file rather than for each test.
- `test/enrichment-abort.test.ts` — also a writer, because one of its cases completes a gather.
- `docs/rollouts/2026-10-21-st-4570-suite-db-isolation.md` — this note.
- `STATUS.md`, `PLAN.md` — the record of this effort.

## Verification

- `npx tsc --noEmit` — exit 0.
- `npx eslint test/data-catalog-completeness.test.ts test/enrichment-coverage.test.ts
  test/enrichment-abort.test.ts` — exit 0.
- A three-file probe over the changed files with `DATABASE_URL` pointed at a scratch database:
  27 tests passed, and the scratch database finished with **0** rows in
  `enrichment_coverage_runs`, where the same probe wrote **12** rows before the change.
- `npx vitest run` over the whole suite, with `DATABASE_URL` pointed at a database that did not
  exist when the suite started — the condition that reproduces the original failure.  Recorded in
  the PR body.

## The detail that decides the shape of the fix

The persistence is fire-and-forget: `setLastEnrichmentCoverageReport` does
`void import("./db-enrichment-coverage").then((mod) => mod.persistEnrichmentCoverageReport(report))`.
A dynamic import of a module that is not already in the file's static graph resolves on a macrotask,
not a microtask, so the write can land **after** the test that triggered it has finished.

That was measured, not assumed.  With the database path set and restored per test, the write landed
after the restore and went straight back into the shared database — the probe wrote 12 rows there.
Restoring the path per test is therefore the wrong shape for a writer, even though it is the right
shape for a reader.  The two writer files hold their path for the whole file, and the reader keeps
the per-test scope, because the reader never writes.

## Decisions & Trade-offs

- **Test-only, no production change.**  A `process.env.VITEST` guard in
  `src/lib/enrichment-coverage.ts` would have stopped the leak at the source, but
  `test/enrichment-coverage-persistence.test.ts` asserts that persistence *does* happen, so the
  guard would have broken a test that is asserting the intended behaviour.  Isolating the database
  per file is also what the repo already does everywhere else.
- **The reader is fixed even though the writers are the source.**  Making the writer hermetic stops
  the pollution; it does not make the reader's premise true.  A reader that asserts an empty
  universe should own the database it asserts about, so that its result does not depend on what ran
  before it.
- **No regression guard added here.**  The obvious one — run the suite twice and assert the two runs
  agree — is a repo-level check rather than a test-file change, and it belongs with the repo's own
  gate.  It is recorded as a follow-up on ST-4570.
- **Kept off the public-pages branch.**  The fix is on its own branch off `origin/main`, so it does
  not widen the diff of PR #4889 and it carries no unattributed commit, so it needs no owner approval
  to land.

## Follow-ups

- Add the repo-level guard: run the suite twice against one checkout and assert the second run
  matches the first.  That is the property that was broken, and the per-file fix does not assert it.
- Consider whether the remaining test files that do not set `DATABASE_URL` should also be made
  explicit.  They do not reach the persistence path today, so this change does not touch them, but
  the convention is only as strong as its exceptions.

## Zero-Code Findings

- The vitest config runs with `maxWorkers: 1`, so the test files execute sequentially in one worker
  process, and `process.env.DATABASE_URL` leaks from one file to the next inside that process.  A
  file that sets its own database path therefore changes what the next file sees unless it restores
  the previous value.
- `data/` is gitignored and `data/app.db` is never committed, so it is a per-machine artefact that
  accumulates across runs and is invisible to every other checkout.  A test whose result depends on
  that file is testing the machine, not the code.

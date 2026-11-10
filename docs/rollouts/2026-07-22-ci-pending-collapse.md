# CI pending-run collapse

## Summary

Removed the commit SHA from the required CI concurrency group. GitHub now groups runs by
workflow and ref, retaining the active run and newest pending run while preserving
`cancel-in-progress: false`.

## Why

The temporary SHA suffix made every push a unique concurrency group. With cancellation disabled,
superseded pending runs accumulated instead of collapsing, exhausting the three available
`socratic-ci` runner slots and delaying every PR's required `verify` check.

## Files

- `.github/workflows/ci.yml`
- `test/ci-workflow-queue-safety.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-22-ci-pending-collapse.md`

## Verification

- `npx vitest run --maxWorkers=1 test/ci-workflow-queue-safety.test.ts`
- YAML parse and diff checks before push
- The PR's required hosted `verify` check remains authoritative for the full lint, TypeScript,
  test, and production-build gate.

## Follow-ups

Open a ready PR and arm auto-merge. Do not cancel active full suites; after this change is on
`main`, cancel only stale queued duplicates if GitHub does not retire them automatically, then
verify the production SHA after auto-deploy.

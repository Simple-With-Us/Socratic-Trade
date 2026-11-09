# 2026-08-30 -- PR #3111 CI unblock (asc-seq stderr + trial-pin)

## Context & Objective

PR #3111 (`compiler/asc-seq-surface-stderr`, head `50e288cb0`) was MERGEABLE but
BLOCKED: `verify-hosted` failed `npm test`, so the required `verify` gate failed
open-never.  Intent stays: surface `asc-seq` node stderr and stop the unverified
die-text from claiming there is no local sequence when one exists.  Do not
extra-ship.  Do not `--force-ship`.

## Changes Made

- Merged `origin/main` (`0558d7907`) into the PR branch so the suite matches
  current main.
- `test/ops-snapshot.test.ts` -- `buildOpsSnapshot` uses `Date.now()`.  The
  2026-08-30T00:00:00.000Z pin from #3113 is already past (CI of 2026-08-27 was
  the original red; today is 2026-08-30 05:38 UTC).  Pin the trial end to
  now+7d so the fixture cannot calendar-rot again.
- iOS fleet files from `50e288cb0` are unchanged: `asc_latest_seq` keeps node
  stderr, unverified die-text names `local=` / `project=`, and
  `test-ship-seq.sh` case 11 asserts that.

Touched:

- `scripts/ios-fleet/ship-testflight.sh` (from original PR commit)
- `scripts/ios-fleet/test-ship-seq.sh` (from original PR commit)
- `scripts/ios-fleet.sha256` (from original PR commit; pin matches)
- `test/ops-snapshot.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- Relative `now+7d` pin instead of bumping another hardcoded UTC date.  Sibling
  pinecone tests freeze `now` and keep their historical calendar; only this
  snapshot fixture reads wall-clock time.
- Did not extra-ship or `--force-ship`.  Normal `ios-ship.yml` on merge is OK.

## Verification State

- `bash scripts/ios-fleet/test-ship-seq.sh` -- 50 passed, 0 failed (includes
  case 11 unverified ASC die-text).
- `vitest run test/ops-snapshot.test.ts` -- 8/8 passed.
- Failed CI receipts: verify job 98390233041 (gate: hosted failure);
  verify-hosted job 98387460511 (`test/ops-snapshot.test.ts:228`
  `trial.active` expected true, got false).

## Next Steps & Blockers

- Push this branch.  If the PR is MERGEABLE, non-draft, and checks green,
  squash-merge.  Else stop after the push.
- Auto-merge is already armed (squash).

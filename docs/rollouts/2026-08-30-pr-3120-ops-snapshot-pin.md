# 2026-08-30 -- PR #3120 CI unblock (ops-snapshot trial pin)

## Context & Objective

PR #3120 (`ag/st-auth-and-transcripts`, head `0a6979192`) was MERGEABLE but
BLOCKED: `verify-hosted` failed `npm test`, so the required `verify` gate failed
open-never.  Failure is `test/ops-snapshot.test.ts` `trial.active` expected true
got false.  Not an ios ship-seq failure.  Intent stays: iOS auth-redirect +
resilient workspace decoding, and EarningsCalls.dev / ROIC.ai labels.  Do not
squash-merge.  Do not extra-ship.  Do not `--force-ship`.

## Changes Made

- Merged `origin/main` (`f385fb037` / #3111) into the PR branch so the suite
  matches current main and picks up the now+7d ops-snapshot trial pin.
- `test/ops-snapshot.test.ts` -- `buildOpsSnapshot` uses `Date.now()`.  The
  2026-08-30T00:00:00.000Z pin from #3113 is already past.  #3111 already pinned
  the trial end to now+7d; this branch now carries that same pin.  Auth and
  transcript files from `0a6979192` are unchanged.

Touched:

- `test/ops-snapshot.test.ts` (via merge of #3111)
- `app/api/mobile/auth-redirect/route.ts` (from original PR commit)
- `ios/SocraticTrade/MobileModels.swift` (from original PR commit)
- `app/admin/connections/connections-health-client.tsx` (from original PR commit)
- `src/lib/data-catalog.ts` (from original PR commit)
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- Merge, not rebase: keep the existing PR commit and avoid a force-push.
- Did not re-implement the pin as a second edit.  Replicating #3111 means
  carrying `f385fb037` onto this branch.
- Did not squash-merge, extra-ship, or `--force-ship`.

## Verification State

- `vitest run test/ops-snapshot.test.ts` -- pending in this note until run.
- Failed CI receipts: verify-hosted job 99216609082 (`trial.active` expected
  true, got false); verify job 99218276750 (gate: hosted failure).

## Next Steps & Blockers

- Push `ag/st-auth-and-transcripts`.  Do not squash-merge.  Do not extra-ship.
  Do not `--force-ship`.
- Wait for `verify-hosted` then required `verify` to go green.

## Zero-Code Findings

None.  The red was the expired calendar pin, same class as #3111.

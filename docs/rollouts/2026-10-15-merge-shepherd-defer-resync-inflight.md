# 2026-10-15 — Merge shepherd defer re-sync while CI in flight (ST-2874)

## Context & Objective

Armed PRs starved when something called `gh pr update-branch` every ~15–19 minutes while `verify-hosted` needs ~20 minutes.  Each re-sync cancelled the in-flight run, so `verify` never reached SUCCESS (board ST-2874 / Monet 2026-08-21).  The merge shepherd already avoided re-sync for `verify=NONE` when other checks were running; it did not defer **behind-main** syncs while CI was still running on the current head.

## Changes Made

- Added `ci_in_flight()` (any in-progress check rollup entry, or `verify` not in a terminal state).
- `shepherd_sync_behind` and dry-run `BEHIND` classification skip `update-branch` until CI finishes on the current head.
- Contract selftest: `scripts/merge-shepherd-ci-inflight.selftest.sh`.

**Files:** `scripts/merge-shepherd.sh`, `scripts/merge-shepherd-ci-inflight.selftest.sh`, `docs/rollouts/2026-10-15-merge-shepherd-defer-resync-inflight.md`, `STATUS.md`.

## Decisions & Trade-offs

- Did not change the Mac `~/.claude-merge-shepherd` driver interval; repo script is the source of truth agents copy to the host.
- A PR that is BEHIND with a failed verify still follows the existing failure/rerun path; this only blocks sync during active runs.

## Verification State

```bash
bash -n scripts/merge-shepherd.sh
bash scripts/merge-shepherd-ci-inflight.selftest.sh
SHEPHERD_DRY_RUN=1 bash scripts/merge-shepherd.sh
npm run lint
npx tsc --noEmit
```

GB-MONITOR pickup (2026-10-15): merged `origin/main` into PR branch (`7a779aeb`); `verify` on #4705 was green before merge-forward; re-run expected after push.

## Next Steps & Blockers

- Mac host: refresh `~/.claude-merge-shepherd/merge-shepherd.sh` from `main` after merge.

## Zero-Code Findings

Fleet recall confirmed the 15-min cadence was not the 30-min launchd shepherd when logs showed "CI running" WAITING; any PAT-backed `update-branch` path needs this guard.

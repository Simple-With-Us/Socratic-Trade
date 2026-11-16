# 2026-10-15 — Merge shepherd defer re-sync while CI in flight (ST-2874)

## Context & Objective

Armed PRs starved when something called `gh pr update-branch` every ~15–19 minutes while `verify-hosted` needs ~20 minutes.  Each re-sync cancelled the in-flight run, so `verify` never reached SUCCESS (board ST-2874 / Monet 2026-08-21).  The merge shepherd already avoided re-sync for `verify=NONE` when other checks were running; it did not defer **behind-main** syncs while CI was still running on the current head.

## Changes Made

- Added `ci_in_flight()` (any in-progress check rollup entry, or `verify` not in a terminal state).
- `shepherd_sync_behind` and dry-run `BEHIND` classification skip `update-branch` until CI finishes on the current head.
- Terminal `verify` conclusions include `NEUTRAL` and `SKIPPED` (Kody #4705).
- Contract selftest: `scripts/merge-shepherd-ci-inflight.selftest.sh`.

**Files:** `scripts/merge-shepherd.sh`, `scripts/merge-shepherd-ci-inflight.selftest.sh`, `docs/rollouts/2026-10-15-merge-shepherd-defer-resync-inflight.md`, `STATUS.md`.

## Decisions & Trade-offs

- Did not change the Mac `~/.claude-merge-shepherd` driver interval; repo script is the source of truth agents copy to the host.
- A PR that is BEHIND with a failed verify still follows the existing failure/rerun path; this only blocks sync during active runs.

## Verification State

Commands on this branch (per handoff.mdc — **ok** only when run on the commit being handed off; **N/A** when out of scope or not run this session):

| Command | Result |
|---|---|
| `bash -n scripts/merge-shepherd.sh` | -> ok (this session) |
| `bash scripts/merge-shepherd-ci-inflight.selftest.sh` | -> ok (this session) |
| `SHEPHERD_DRY_RUN=1 bash scripts/merge-shepherd.sh` | -> N/A (needs `gh` + open PRs; not run this session) |
| `npm run lint` | -> N/A (shell-only change; authoritative gate is PR `verify`) |
| `npx tsc --noEmit` | -> N/A (no TS touched; authoritative gate is PR `verify`) |
| `npm test` | -> N/A (no vitest for bash; authoritative gate is PR `verify`) |
| `npm run build` | -> N/A (no app/runtime change; authoritative gate is PR `verify`) |

Merge-forward with `origin/main` at `960637ec` (2026-10-15); no conflict markers in shepherd/STATUS/rollout after merge.

CI `verify` on PR #4705 is the authoritative full gate after push.

## Next Steps & Blockers

- Mac host: refresh `~/.claude-merge-shepherd/merge-shepherd.sh` from `main` after merge.

## Zero-Code Findings

Fleet recall confirmed the 15-min cadence was not the 30-min launchd shepherd when logs showed "CI running" WAITING; any PAT-backed `update-branch` path needs this guard.

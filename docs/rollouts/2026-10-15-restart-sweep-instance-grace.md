# 2026-10-15 — Restart sweep boot grace, instance scope, drain adoption (ST-8)

## Context & Objective

PR #3138 sweeps every `strategy_runs` row that started before this process booted, on the first tick, and the scheduler runs that sweep before the leader gate.  A follower can close a run the leader still owns.  The same sweep fails the matching `strategy_run_requests` row before drain can adopt it.  ST-8 asks for the boot grace back, an instance-scoped sweep, and no pre-emption of drain adoption.

## Changes Made

The restart arm stays quiet for `RESTART_SWEEP_BOOT_GRACE_MS` (two minutes).  `insertStrategyRun` stamps `owner_instance` with this process's id (migration 95).  The pre-gate sweep passes `reapUnowned: false`, so a follower's UPDATE cannot match the leader's rows.  After the scheduler lease is held, a second sweep may reap other instances.  A pre-boot row with a `running` request that is not a restart retry is left for `processPendingStrategyRunRequests`.  A time-stale run this process owns is still swept at 30 minutes, even while its lock guard renews.  A live lease still protects a run this process does not own, on both arms.

- `src/lib/process-instance.ts` (new)
- `src/lib/scheduler-lease.ts`
- `src/lib/db.ts`
- `src/lib/db-execution.ts`
- `src/lib/strategy-run-retry.ts`
- `src/lib/scheduler.ts`
- `test/restart-sweep-instance-scope.test.ts` (new)
- `test/stale-running-runs.test.ts`
- `test/stale-running-runs-adoption-grace.test.ts`
- `test/strategy-run-restart-retry.test.ts`
- `test/scheduler-leader-heartbeat.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-10-15-restart-sweep-instance-grace.md`

## Decisions & Trade-offs

Boot grace is two scheduler ticks, not the old 30-minute wait.  Restoring the full 30 minutes would hide a wedged run this process owns, which is the stuck-run case #3138 fixed.  Grace applies only to the restart arm.

`reapUnowned` defaults false.  The leader opts in only after `acquireOrRenewLeadership` returns true.  Legacy NULL `owner_instance` rows are unowned, so a follower does not sweep them either.  The leader may, after the grace, and only when no live lease and no adoptable request are present.

Drain adoption is detected by a `running` `strategy_run_requests` row with `retry_of_run_id` NULL.  The drain drops a running retry instead of adopting it, so those rows are still swept.  The 30-minute stall arm does not skip adoptable requests.  A wedge that old is not a fresh adopt.

## Verification State

Commands are recorded after they run.  See the commit that follows this note if this section still says pending.

- Pending: `npm run lint`
- Pending: `npx tsc --noEmit`
- Pending: `npx vitest run` on the sweep tests, then `npm test`
- Pending: `npm run build`

## Next Steps & Blockers

Open the PR ready for review.  Add `do-not-automerge`.  Do not enable auto-merge.  Post the PR link on Linear ST-8.  Jay squash-merges.

## Zero-Code Findings

Agent-Sync MCP Linear tools are not enabled for the CURSOR seat (`LINEAR_SEATS`).  The claim went through the fleet `board` CLI as CURSOR, which `board whoami` verified against `LINEAR_CURSOR_CLIENT_ID`.  Zulip `agent-sync whoami` has no key on this seat.

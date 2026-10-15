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
- `scripts/check-shared-package-pin.mjs`
- `.github/workflows/shared-package-pin-check.yml`
- `test/shared-package-pin-check.test.ts`

## Decisions & Trade-offs

Boot grace is two scheduler ticks, not the old 30-minute wait.  Restoring the full 30 minutes would hide a wedged run this process owns, which is the stuck-run case #3138 fixed.  Grace applies only to the restart arm.

`reapUnowned` defaults false.  The leader opts in only after `acquireOrRenewLeadership` returns true.  Legacy NULL `owner_instance` rows are unowned, so a follower does not sweep them either.  The leader may, after the grace, and only when no live lease and no adoptable request are present.

Drain adoption is detected by a `running` `strategy_run_requests` row with `retry_of_run_id` NULL.  The drain drops a running retry instead of adopting it, so those rows are still swept.  The 30-minute stall arm does not skip adoptable requests.  A wedge that old is not a fresh adopt.

## Verification State

Run on this branch after the sweep change.

- `npm run lint` — exit 0.  854 problems (0 errors, 854 warnings), the existing warning baseline.
- `npx tsc --noEmit` — exit 0.
- Targeted vitest (`test/restart-sweep-instance-scope.test.ts`, `test/stale-running-runs-adoption-grace.test.ts`, `test/stale-running-runs.test.ts`, `test/strategy-run-restart-retry.test.ts`, `test/scheduler-leader-heartbeat.test.ts`, `test/persistence-hardening.test.ts`) — pass.
- `npm test` — 9380 passed, 51 skipped, 25 failed.  The 25 are outside this diff: LLM and notify tests that see a sandbox `OPENROUTER` / Pushover credential, Twelve Data and Alpha Vantage provider fixtures, `cpuprofile-summary` failing on Node's `.ts` loader, and `server-metrics` `usesLocalHost`.  None are in the sweep files.
- `npm run build` — exit 0.  Compiled with the existing warnings, 43 static pages.

## Check-pin (shared failure on every PR in the burst)

`check-pin` on this PR, and on the other open PRs between 07:32Z and 07:55Z, failed the same way: `API rate limit exceeded for user ID 12656028` while reading `jaywedgeworth22/Congress.Trade` `VENDOR-PROVENANCE.md`, then `::error::cannot read private Congress.Trade vendor provenance; set GH_PACKAGES_TOKEN`.  ST and UM were already both `v2.7.1` at lock SHA `5084afb3ffb269e7e28e0c30c880cab7d93409e7`, which matches the public provenance file.  Congress.Trade is public.  The script preferred `GH_PACKAGES_TOKEN`, a shared user PAT, over the Actions `GITHUB_TOKEN`.  That PAT is user 12656028.  When the fleet burns its hourly budget, every PR that runs this check goes red, including money-path PRs that do not touch the pin.  The three same-token retries do not clear a primary rate limit.  The script now tries `GITHUB_TOKEN`, then `GH_TOKEN` if it differs, then the PAT.  A rate-limit response switches credentials immediately and is reported as a rate limit.

`origin/main` (`df7e6d10`, #4703 / #4708 / #4702) is merged with a merge commit.  Migration 95 stayed the only new migration.  No review threads were open.

## Next Steps & Blockers

PR #4701 stays ready for review with `do-not-automerge`.  Auto-merge stays off.  Jay squash-merges.  Resolve ST-8 only after the fix has shipped.

## Zero-Code Findings

Agent-Sync MCP Linear tools are not enabled for the CURSOR seat (`LINEAR_SEATS`).  The claim went through the fleet `board` CLI as CURSOR, which `board whoami` verified against `LINEAR_CURSOR_CLIENT_ID`.  Zulip `agent-sync whoami` has no key on this seat.

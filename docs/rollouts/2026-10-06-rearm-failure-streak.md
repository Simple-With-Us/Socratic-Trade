# 2026-10-06 - Autopilot re-arm streak

## Context & Objective

Re-arming an account (`set_system_state` active) was undone within seconds.  The run-failure watchdog used `lastHaltStreak` as a floor equal to the streak at halt time, then halted again when the raw streak was strictly greater than that floor.  A strategy run already in flight at re-arm time could fail afterward, add one to the raw streak, and skip the floor.  Most of the live streak (Alpaca Paper 13, Tradier Sandbox 12) was leftover from 2026-09-30 to 2026-10-01 OpenRouter and stale-sweep failures.  Related Sentry issues SOCRATIC-TRADE-2R and 2T, and PagerDuty #322, stay open until a clean completed run.

## Changes Made

Only runs whose `started_at` is strictly after the re-arm receipt count toward the next alert, backoff, and auto-halt.  The halt threshold is unchanged (default 10; env `ST_RUN_FAILURE_HALT_AFTER`).  The same window feeds `/api/health` `tradingLiveness.maxConsecutiveFailedRuns` and the ops snapshot's per-account `consecutiveFailedRuns`, both of which already call `computeAccountTradingLiveness`.

- `src/lib/run-failure-watchdog.ts` — record `rearmedAt` from the earliest post-halt audit (`policy_change` with `systemState` active, or ops `set_system_state` to active).  Effective streak is consecutive failures that started after that instant.  An in-flight row is omitted until it finishes, and a finish of a pre-re-arm start does not count.  `lastHaltStreak` is reset to 0 on the new episode so the full threshold still applies.  A zero effective streak does not clear the window until a finished run has started after `rearmedAt`.  An unreadable run log does not count as recovery.  An old episode that still has a raw floor and no `rearmedAt` adopts `firstSeenAt`.  The not-in-summary path opens that window instead of wiping state.
- `src/lib/trading-liveness.ts` — shared settings key, `countLeadingFailedRuns`, and `runFailureRearmCutoff`.  Health uses the saved window.  `stale_last_completed_run` is still the real age of the last completed run.
- `test/run-failure-watchdog.test.ts` — in-flight failure does not halt; a failure that already landed before the re-arm tick does not halt; N new post-re-arm failures do halt; a post-re-arm success resets the streak.
- `test/trading-liveness.test.ts` — cutoff equality, one later failure, a later success, and the public post-re-arm streak.
- `docs/runbooks/uptime-health-json-monitors.md` — field accuracy for `maxConsecutiveFailedRuns`.
- `docs/rollouts/2026-09-30-self-healing-watchdogs.md` — pointer to this note.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`.

No phase doc owns this watchdog.  The 2026-09-30 rollout remains the design record.

## Decisions & Trade-offs

Raising the floor to `max(halt streak, current raw streak)` does not fix a run that fails after the re-arm tick.  The timestamp filter does.  Alert and backoff use the same effective streak, so re-arm does not immediately page or suppress runs.  If the audit lookup misses, the tick time is the cutoff.  That still excludes anything already in flight and can miss a run that started in the gap between the real re-arm and the tick.  The scheduler runs this tick before it launches due runs, so a run started on the same tick is after the window.  Already re-halted accounts are not un-halted.  No account was re-armed.  No trading cap or limit changed.

## Verification State

On `0fa100ea` (PR #4259):

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/run-failure-watchdog.test.ts test/trading-liveness.test.ts --testTimeout=20000
```

`npm run lint` exited 0 (0 errors, 863 grandfathered warnings).  `npx tsc --noEmit` exited 0.  Targeted vitest: 2 files, 26 passed.  Full `npm test` and `npm run build` follow on this head; CI `verify` is the merge gate.

## Next Steps & Blockers

Open the PR.  Merge only when `verify` is green and review is clear.  Do not force-merge.  Do not re-arm Alpaca Paper or Tradier Sandbox from this lane.  Sentry SOCRATIC-TRADE-2R and 2T and PagerDuty #322 close only after a clean completed run.  Weekday regular hours may latch the Coolify image until after the cash close.  Do not trigger that deploy by hand.

## Zero-Code Findings

The old test expected one new failure to re-halt.  That encoded the bug.  It was replaced.  Production halt default stays 10.

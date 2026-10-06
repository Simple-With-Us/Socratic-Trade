# 2026-10-05 — App-stall failures exempt from Autopilot auto-halt

## Context & Objective

On 2026-10-01 RTH, event-loop stalls failed strategy runs back-to-back.  The run-failure watchdog then AUTO-HALTED Alpaca Paper (`4f7c96ba`) and Tradier Sandbox after streaks of 10–12.  The scheduler already labels some of those failures "App process was stalled ... broker not at fault".  Those runs should still alert and back off.  They must not count toward `ST_RUN_FAILURE_HALT_AFTER`.

## Changes Made

The auto-halt streak is now a subset of the consecutive-failure streak.  `consecutiveFailedRuns` still counts every failed run and still drives the alert, the backoff, and the liveness `consecutive_failures` reason.  `consecutiveHaltEligibleFailures` is that same walk with app-stall and mid-run-restart failures removed.  The watchdog halts only on the second number.

Exempt from auto-halt:

- `strategy_run_crashed` cause `process_restarted_mid_run`
- `strategy_run_crashed` cause `stalled_no_progress` (same sweep, same `haltExempt: true` flag)
- summaries "Process restarted mid-run" and "Strategy run stalled with no progress"
- "App process was stalled" / "broker not at fault"
- an event-loop stall that "dominated the window"

Still counted toward auto-halt:

- broker HTTP failures, including `fetch failed` and HTTP 500
- a lane deadline that only reports a measured stall (`event-loop stall=120ms`) without "dominated the window"
- LLM and provider failures

The health path classifies from the run summary so it does not join `audit_events` on every probe.  The sweep writes the matching summary and `haltExempt: true` together, for both causes.

Touched files:

- `src/lib/run-failure-watchdog.ts`
- `src/lib/trading-liveness.ts`
- `src/lib/db-execution.ts`
- `test/run-failure-watchdog.test.ts`
- `test/trading-liveness.test.ts`
- `test/stale-running-runs.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-05-stall-failures-exempt-halt-streak.md`

## Decisions & Trade-offs

A stall between broker failures does not reset the halt streak.  It is skipped, not a success.  A completed run still breaks both streaks.

`stalled_no_progress` is exempt along with `process_restarted_mid_run`.  Both are the stale-run sweep closing a run the app did not finish.  A broker or LLM error that returns and fails the run is a different summary and still counts.  A parenthetical stall measurement on a broker timeout still counts, so a real broker deadline is not relabeled as an app stall.

No phase-doc change.  This does not change strategy, orders, or risk limits.

## Verification State

```bash
npm run lint          # exit 0.  0 errors, 863 warnings (grandfathered).
npx tsc --noEmit      # exit 0.
npm test              # 11 failed, 9051 passed, 51 skipped (9113).
npm run build         # exit 0.
```

The 11 failures are outside this diff.  None are in `test/run-failure-watchdog.test.ts`, `test/trading-liveness.test.ts`, or `test/stale-running-runs.test.ts`.  They are `test/alpha-vantage-key-pool.test.ts`, `test/congress-share.test.ts`, `test/cpuprofile-summary.test.ts` (Node 22 cannot import the `.ts` helper), `test/data-providers.test.ts` (Twelve Data), `test/notify-body-tiers.test.ts`, `test/notify-user-creds.test.ts` (cloud env returns a redacted token), `test/persistence-notification.test.ts`, and `test/server-metrics.test.ts`.

Targeted, before the full suite:

```bash
npx vitest run test/run-failure-watchdog.test.ts test/trading-liveness.test.ts test/stale-running-runs.test.ts
```

44 passed.  Those files are among the 9051 that passed in the full suite.

## Next Steps & Blockers

PR #4210 is open.  Do not merge.  Do not Coolify Deploy.  Extra-ship no.  Owner re-arm is still required for any account this watchdog already halted.

## Zero-Code Findings

None.  The halt decision was reading `consecutiveFailedRuns`, which counts every `failed` row.

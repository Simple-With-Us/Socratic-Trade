# 2026-10-09 — One finished-run lookback per watchdog tick

## Context & Objective

Kody flagged a redundant `strategy_runs` SELECT on PR #4210.  For an active account on the re-arm path, each tick ran the same newest-finished-runs lookback three times: inside `getTradingLivenessSummary`, then `failuresStartedAfter`, then `haltEligibleFailuresStartedAfter`.  The counts must stay the same.  The read should happen once.

## Changes Made

`loadRecentFinishedRuns` is the single SELECT (`status`, `started_at`, `summary`, newest start first, limit 200).  `computeAccountTradingLiveness` uses it for both `countLeadingFailedRuns` and `countLeadingHaltEligibleFailedRuns`.  `getTradingLivenessSummary` copies that array into an optional map.  The watchdog walks the cached array when it recomputes the post-re-arm streak and the halt-eligible subset.  A missing cache entry still reads once and feeds both counters.  An unreadable log is still not treated as recovery.  `hasFinishedRunStartedAfter` stays a separate existence probe.

Touched files:

- `src/lib/trading-liveness.ts`
- `src/lib/run-failure-watchdog.ts`
- `test/run-failure-watchdog.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-09-watchdog-one-finished-run-read.md`

## Decisions & Trade-offs

The tick reuses the rows loaded while building the liveness summary, then applies the re-arm cutoff in memory.  That is the same array both counters already walked for the summary's own cutoff.  A run that commits during an earlier account's notification await is visible on the next tick.  No halt threshold, backoff knob, or stall exemption changed.

No `docs/phase-*.md` change.  None of those files define this watchdog.

## Verification State

```bash
npx eslint src/lib/run-failure-watchdog.ts src/lib/trading-liveness.ts test/run-failure-watchdog.test.ts
# exit 0
npx tsc --noEmit
# exit 0
npx vitest run test/run-failure-watchdog.test.ts test/trading-liveness.test.ts --testTimeout=20000
# 2 files, 35 passed
```

Full `npm test` and `npm run build` were not run.  This seat's task was the narrow watchdog gate.

## Next Steps & Blockers

PR #4210 stays open.  Do not merge.  Do not Coolify Deploy.

## Zero-Code Findings

None.

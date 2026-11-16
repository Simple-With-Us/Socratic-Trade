# 2026-10-15 - Run-failure watchdog re-arm timestamp flake (ST-4521)

## Context & Objective

CI intermittently failed `runFailureWatchdogTick > does not halt when a run in flight at re-arm later fails` with `saved.rearmedAt` a few milliseconds before the re-arm `policy_change` audit `created_at`.  Linear ST-4521.

## Changes Made

- `src/lib/run-failure-watchdog.ts` — set the halt marker `since` from the halt `policy_change` audit receipt (`latestPolicyChangeCreatedAt`) instead of the watchdog tick's entry `now`, so `resolveRearmTimestamp` does not treat an older still-active `policy_change` as the re-arm cutoff.
- `test/run-failure-watchdog.test.ts` — assert against the latest active `policy_change` receipt (same JSON filter as production).

## Decisions & Trade-offs

Kept `resolveRearmTimestamp` semantics (earliest active receipt after halt).  The bug was the halt floor being too early, not the ASC ordering.  Did not relax the test to a millisecond tolerance; production and test should agree on the audit string.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/run-failure-watchdog.test.ts
npm run build
```

`npm run lint` 0 errors.  `tsc` clean.  Watchdog file 23/23.  `npm run build` ok.  Supplementary flake replay: `for i in $(seq 1 30); do npx vitest run test/run-failure-watchdog.test.ts -t "does not halt when a run in flight"; done` (30/30).

## Next Steps & Blockers

Merge when `verify` is green.  Fixes ST-4521.

## Zero-Code Findings

None.

# Drain must not adopt a frozen-but-live Manual Run

## Context & Objective

#2853 taught drain to resume a claimed `running` Manual Run once when the HTTP kick died after `queued → running`.  Liveness was `heartbeat.at` younger than 90s.  The 15s interval that refreshes that timestamp does not fire while the event loop is frozen (SQLite `busy_timeout` is 60s; #2967 measured 55s health stalls and >120s back-to-back).  `runStrategyOnce` is still on the stack.

Drain then called `releaseStrategyLock` for that same run id and started a second `runStrategyOnce`.  The living worker can already have passed `lockGuard.assertOwned()` before `placeEquityOrder`, so the adopted run submits a second order.

## Changes Made

- `src/lib/strategy-run-requests.ts` — `isStrategyRunExecutionLive` is map presence on this process.  A missing entry (process restart) is still an orphan and is still adopted.
- `test/strategy-run-drain-handoff.test.ts` — regression: beat older than 90s + map entry present → do not adopt.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

## Decisions & Trade-offs

- A hung worker that stays in the map is left single-flight.  Starting a second gather is worse than waiting for the hang to surface as `stalled_no_progress`.
- Did not add a durable claim-generation column.  Same-process liveness is the freeze bug; process restart still has an empty map.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/strategy-run-drain-handoff.test.ts
```

## Next Steps & Blockers

- None for this slice.  Did not touch #2947 / #2952 / #2959 / #2963.

# Equity-low broker health skip without auto-halt

## Context & Objective

`checkBrokerHealth` marks accounts with equity below $5 as unhealthy (`category: "equity"`).  `applyBrokerOrderPlacementPause` treated that like a broker outage and auto-halted on first strike (kill_switch + placement marker).  Strategy already skips proposal runs below `MIN_STRATEGY_ACCOUNT_EQUITY` ($10) without halting autonomy.  This change aligns the scheduler health gate: low equity skips the tick only.

## Changes Made

- `applyBrokerOrderPlacementPause`: return `{ action: "none" }` when `health.category === "equity"` (same posture as `processStall`).
- Documented the $5 placeability floor vs $10 strategy floor in `checkBrokerHealth` comments.
- Tests: equity on active account stays active, no `broker_placement_auto_halted`, no kill_switch notification.

**Files touched**

- `src/lib/broker-health.ts`
- `src/lib/scheduler.ts`
- `test/broker-health-auto-pause.test.ts`
- `test/broker-health-probe-resilience.test.ts`
- `docs/rollouts/2026-10-05-equity-low-skip-no-auto-halt.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- No change to `brokerHealthRunSkip` for equity (still `skipped_broker_unhealthy` on in-run paths); only the auto-halt / kill_switch path is removed.
- `shouldPersistBrokerHealthSkip` also persists one `strategy_runs` row per new low-equity skip episode (`skipEpisodeStarted` from `logHealthGateSkip`) with `halted: false` — account stays active, no auto-halt.
- Did not add a new strategy-run status enum; existing skip messaging is sufficient.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/broker-health-auto-pause.test.ts test/broker-health-probe-resilience.test.ts
npm run build
```

`npm run lint` — 0 errors.  `npx tsc --noEmit` — clean.  Local: `npm test -- test/broker-health-auto-pause.test.ts test/broker-health-probe-resilience.test.ts test/scheduler-lane-observability.test.ts`.  PR CI `verify-hosted` runs the full `npm test` suite plus `npm run build` (required `verify` gate).

## Next Steps & Blockers

- Owner review and merge when `verify` CI is green.  No deploy action from this agent (extra-ship no).

## Zero-Code Findings

None.

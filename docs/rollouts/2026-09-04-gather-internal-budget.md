# 2026-09-04 — Gather internal time budget + health-gate skip row

## Context & Objective

Board P0 `06df80cf`: strategy runs were 100% failing because gather had no internal time budget and the 8-minute deadline killed every run.  Abort + last-good tape already landed in #3013/#3018.  Claude's leftover `claude/gather-budget` branch had zero unique commits and `/tmp/st-gather` was gone.  Reconstruct the remaining hole on `origin/main` (`de236a63d`).  Do not treat as ST #3138/#3158/#3162.  No extra-ship.  No TestFlight.

Two failure modes are both real and fire in order:

1. Scheduler `broker-health-gate` when equity reads 0 journals only and writes no `strategy_runs` row.
2. Gather 8-minute deadline after accounts pass the health gate.

## Changes Made

Internal budget (do not raise the 8-minute cap):

- New leaf `src/lib/gather-budget.ts` plans which enrichment waves are still worth starting given remaining wall-clock ms, after reserving 50s for the quote refresh.
- `gatherStrategyMarket` passes `deadlineAt` into `scanMarket`.
- `scanMarket` skips live enrich or shrinks the preselection pool to the ranked cut when remaining is tight, and still uses the durable field store.
- `CascadingEnrichmentProvider` skips keyed Wave B (Finnhub paced) and scarce Wave C when remaining is below 90s / 20s usable.  Wave A retries are also skipped when remaining is that tight.
- If gather abort fires *during* enrichment, `scanMarket` keeps today's ranked Nasdaq tape plus durable seed instead of throwing it away and forcing yesterday's last-good.
- Abort + last-good stay as the safety net when even the screener cannot finish.

Health-gate observability:

- When the scheduler auto-halts an **active** account, persist one `skipped_broker_unhealthy` `strategy_runs` row.  Already-halted ticks stay journal-only so we do not write a row every 15s.
- `strategy.ts` already persisted this skip when a run started; the scheduler gate never started a run.

Touched files:

- `src/lib/gather-budget.ts` (new)
- `src/lib/strategy-gather.ts`
- `src/lib/market.ts`
- `src/lib/data-providers.ts`
- `src/lib/types.ts`
- `src/lib/broker-health.ts`
- `src/lib/scheduler.ts`
- `test/gather-budget.test.ts` (new)
- `test/strategy-gather.test.ts`
- `test/enrichment-abort.test.ts`
- `test/broker-health-auto-pause.test.ts`
- `test/market-preselection.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-09-04-gather-internal-budget.md`

## Decisions & Trade-offs

Did not raise the 8-minute cap.  Did not treat skip rows as liveness `completed` (only a real decision cycle counts).  Did not persist a skip on transient connectivity ticks before the halt streak.  Did not change the $5 equity gate itself — unfunded accounts still skip trading; they now leave a durable row when Autopilot auto-halts.  Did not touch alpaca.getOrders timeout mode or restart-loop alerting (`a9676caf`).

## Verification State

```
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/gather-budget.test.ts test/strategy-gather.test.ts test/enrichment-abort.test.ts test/broker-health-auto-pause.test.ts test/market-preselection.test.ts
# 29 passed
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit   # clean
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test           # 7773 passed / 51 skipped, 710 files
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build      # Next webpack succeeded after crypto import fix
```

First land.sh build failed on `import { randomUUID } from "node:crypto"` in `broker-health.ts` (webpack UnhandledSchemeError).  Follow-up commit uses `from "crypto"` like `db-health.ts`.

## Next Steps & Blockers

1. After merge, weekday RTH latch may defer Coolify until after the cash close.  Do not HOTFIX.
2. Confirm the next Roth/Paper run is `completed` or `strategy_gather_used_last_good` / a trimmed-enrich live tape, not another gather timeout.
3. Confirm an equity-0 auto-halt writes `skipped_broker_unhealthy` once, then stays halted.
4. Live `tradingLiveness.degraded=1` with `oldestCompletedRunAgeSeconds` ~2.7d is a completed-run age on still-active accounts; skip rows do not reset that counter.

## Zero-Code Findings

`claude/gather-budget` was created from `origin/main` at `d39853ccd` (2026-08-20) with no unique commits.  Leftover worktree `/tmp/st-gather` is missing.  Live `/api/health` 2026-09-04 ~7:53 AM CT: `ok` sha `90f46d03`, `schedulerStale` false, `tradingLiveness.degraded=1`, `oldestCompletedRunAgeSeconds` ~237099, `marketOpen` false.

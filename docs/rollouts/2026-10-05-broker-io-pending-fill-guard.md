# Broker I/O — pending-fill scheduler guard (board 28996d82 follow-up)

## Context & Objective

Board item `28996d824eee4919` (`broker-io-deadlines`): bound broker I/O and ensure protective scheduler lanes do not latch forever on hung calls.  The 2026-08-19 lane (`PR #2886`, `#3313` axios default timeout) already added adapter deadlines and `withLaneDeadline` on synthetic-stop and stale-limit lanes with in-flight guards released only by real work.

Investigation on `main` (2026-10-05): those protective paths hold.  The remaining gap called out in the expert review was `pending-fill-reconcile` — fire-and-forget every tick with no in-flight guard, so a slow reconcile could stack concurrent passes.  `getEquityTradability` → `getAsset` was also missing the shared `ALPACA_BROKER_IO_DEADLINE_MS` inner deadline.

## Changes Made

- **`src/lib/scheduler.ts`**: globalThis-pinned `pendingFillReconcileInFlight` set; wrap `pending-fill-reconcile` in the same pattern as stale-limit (guard on real work + `withLaneDeadline` for timeout logging only — work is not aborted).
- **`src/lib/alpaca.ts`**: `getAsset` calls use `trackHealth` with `deadlineMs: ALPACA_BROKER_IO_DEADLINE_MS`.
- **`test/scheduler-pending-fill-inflight-guard.test.ts`**: integration test via `_runSchedulerTickForTest` — a hanging `reconcilePendingFills` must not get a second launch on the next tick.

## Decisions & Trade-offs

- Did not add `recordLaneFailure` / `lane_degraded` for pending-fill — that observability path remains limited to money-adjacent protective lanes (stop monitor, stale exit).
- Did not change in-flight semantics for stop/stale lanes (money-path duplicate-launch fix from 2026-08-20 stands).

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # pass
npm test -- test/scheduler-pending-fill-inflight-guard.test.ts test/broker-io-deadlines.test.ts  # 9/9 pass
npm run build         # pass
```

## Next Steps & Blockers

- None for this slice.  Alpaca transport-layer socket abort (`#2970`) remains a separate cluster.

## Zero-Code Findings

- Protective lanes (synthetic-stop, stale-limit) and broker adapter deadlines were already present on `main` before this follow-up.

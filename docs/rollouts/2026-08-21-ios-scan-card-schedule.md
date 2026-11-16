# 2026-08-21 — Scan card tap + honest iOS last/next run

## Context & Objective

Owner: tapping anywhere on a market-scan stock card should open company info, not just the ticker.  Company name on the iOS scan card should read as darker black than industry.  Roth IRA Home showed "not scheduled" for both Last Run and Next Run while Autopilot was on.  Last run is a completed stamp and must never reuse cadence copy.

## Changes Made

Scan cards (iOS `ScanRow` and the website phone card list) are now a full-card hit target.  The watchlist star stays its own control.  iOS prints company name in primary/semibold and keeps industry (or sector) in secondary caption.

`getSchedulerState` no longer returns a blank in-memory clock after a restart or after the cash close.  Last run falls back to `strategy_runs.started_at`.  While `systemState === "active"`, next run is the live cadence stamp, else last-run + cadence, else the next session open.  The tick writes that next-session stamp when the market is closed instead of leaving `nextRunAt` null.

iOS Last Run uses `AppFormat.lastRun` (`never` when missing).  Next Run uses `AppFormat.nextRun` (`not scheduled` only when autonomy is off).

Touched files:

- `src/lib/scheduler-presentation.ts`
- `src/lib/scheduler.ts`
- `src/lib/dashboard.ts`
- `src/lib/market-hours.ts`
- `src/lib/mobile-scan.ts`
- `app/console/ui/symbol-drilldown.tsx`
- `app/console/scan/scan-table.tsx`
- `ios/SocraticTrade/ScanView.swift`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `test/scheduler-presentation.test.ts`
- `test/market-hours.test.ts`
- `test/mobile-scan.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`
- `docs/rollouts/2026-08-21-ios-scan-card-schedule.md`

## Decisions & Trade-offs

Did not add `strategyRuns` to the mobile snapshot.  Filling `scheduler.lastRunAt` / `nextRunAt` at the existing field keeps TestFlight binaries working once the API is live.  The watchlist star sits on the trailing edge of the iOS card so it is not a nested button inside the sheet control.  Next-session math uses 9:30 ET (or 4:00 ET when extended hours are on).  Event-only accounts with no fallback interval still have a null next run.

## Verification State

```
npm run lint
# exit 0 (errors only; grandfathered warnings remain)

npx tsc --noEmit
# clean after defaulting runCadenceMinutes for cadenceLaneDecision

npx vitest run test/scheduler-presentation.test.ts test/market-hours.test.ts test/mobile-scan.test.ts
# 3 files / 47 tests passed

npx vitest run test/scheduler-cadence.test.ts test/sentry-inert.test.ts
# 2 files / 12 tests passed

npm test
# 17 failed / 653 passed / 1 skipped files (29 failed / 7439 passed)
# Failures are Yahoo/SEC/Voyage/notify/vector-db files this change did not touch

npm run build
# Next.js 16.3.1 webpack build succeeded
```

Swift compile is CI `ios-build.yml` — this VM has no `xcodebuild`.

## Next Steps & Blockers

Branch merged `origin/main` `e3278a5f` (clean auto-merge) so #3019 is no longer dirty.  Dispatch `verify` via `workflow_dispatch` — cloud-proxy pushes do not fire `pull_request`.  iOS binary change ships only via `scripts/ios-ship-testflight.sh`.  Last/next run honesty on TestFlight 1.0.x still needs the API deploy (weekday RTH latch applies).  Cloud VM cannot run `xcodebuild`; Mac `ios-build.yml` is the Swift compile of record.

## Zero-Code Findings

The iOS "not scheduled" pair was two bugs stacked: `AppFormat.relative` used cadence copy for a missing last-run stamp, and `getSchedulerState` read only the in-memory account clock, which hydrates `nextRunAt: null` on boot and left it null after the cash close.

# 2026-08-31 — Hung scheduler-tick watchdog (GROK)

## Context & Objective

Firefighter SOCRATIC-TRADE-4 (Sentry https://jays-services.sentry.io/issues/7590383425/):  live SHA `189f5a31` stayed up (~3.6h) while `scheduler-tick` missed its cron check-in, `schedulerLastTick` froze at 13:30:42Z, the leader lease expired at 13:32:12Z (90s TTL), `schedulerStale` and `tradingLivenessDegraded` went true with market open, and `GET /api/health` timed out 15s from two networks.  Product bug, not a deploy.  Goal:  a wedged tick must not leave Autopilot dead until process restart, and Sentry Crons must not report `ok` for a tick that never finished.

## Changes Made

A still-in-flight `tick()` skipped every later 60s interval, so lease renew, `scheduler:lastTick`, and the next Sentry check-in never ran.  `tickInner` awaited `drainMaterialEventQueue`, serial `checkBrokerHealth` (no deadline), and every LLM strategy run.  Sentry was told `ok` at tick *start*, so a hang looked healthy until the 1-minute schedule + 5-minute margin (~13:36Z, matching the miss).

- Independent 15s watchdog:  while a tick is inside a 2-minute budget it renews the leader lease (does **not** stamp `lastTick`).  Past the budget it bumps a generation token, clears `__tickInFlight`, closes Sentry as `error`, and kicks a fresh tick.  The abandoned body's `finally` cannot clobber the new guard.
- Honest Sentry:  leader opens `in_progress`, closes `ok` / `error` when the body finishes (or the watchdog sends `error`).  `scheduler:lastTick` moves to that same finish so a hung body goes stale.
- `withDeadline` on material-event drain (15s) and `checkBrokerHealth` (30s, covering the 16+8s Alpaca first+retry budget).
- Strategy runs are launched with stagger but no longer awaited on the tick critical path (account strategy locks still serialize money-path work).

Touched files:

- `src/lib/scheduler.ts`
- `test/scheduler-tick-watchdog.test.ts`
- `test/scheduler-tick-reentrancy.test.ts`
- `test/sentry-inert.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/ops-observability-security.md`
- `docs/runbooks/uptime-health-json-monitors.md`
- `docs/rollouts/2026-08-31-hung-scheduler-tick-watchdog.md` (this note)

## Decisions & Trade-offs

- No `process.exit` on event-loop stall.  A blocked loop cannot run this watchdog either; Sentry miss + `schedulerStale` + the existing HTTP health timeout remain the page, and Coolify `restart: unless-stopped` is still the recovery for a frozen loop.  This PR recovers hung *awaits* in-process.
- Watchdog default 120s (`SCHEDULER_TICK_WATCHDOG_MS`) is under the 5-minute `schedulerStale` / Sentry `checkinMargin` so Autopilot can resume before those pages.  Overlapping a still-running abandoned body is accepted:  strategy locks, `stopMonitorInFlight`, and `staleExitInFlight` already serialize money-path lanes.
- `lastTick` is no longer written at tick start.  A long-but-alive body can look stale only if it exceeds 5 minutes *and* the watchdog failed to unwedge at 2 minutes.

## Verification State

Original work by GROK, sitting uncommitted since 2026-08-31 (base `origin/main` `189f5a31`).  CLAUDE landed it 2026-09-06, 29 commits behind main.  `src/lib/scheduler.ts` had independently changed on main in the same window (#3147 Sentry fleet remainder, #3168 R2 cold-snapshot): main added `logError`/`logWarn`/`recordSchedulerTick` structured metrics and an overrun-duration check in `tick()`, but did **not** add any hung-tick unwedge — a tick that truly never returns still pins `__tickInFlight` forever on main.  Not redundant.  Landed via a manual three-way merge (`git merge-file`) of GROK's watchdog onto main's metrics: kept main's `logError`/`logWarn`/`recordSchedulerTick` call sites, kept GROK's generation-token/watchdog/honest-check-in design, and added `recordSchedulerTick("error", hungForMs)` to the watchdog's unwedge path for metric parity with main's normal-completion path.  Four conflict hunks in `src/lib/scheduler.ts`, all in the Sentry check-in catch block, the broker-health-gate block (`wasActiveForHealthGate` + `withDeadline`), the tick error handler, and the `tick()` wrapper (generation token + duration timing combined) — all mechanical, no logic dropped from either side.

This worktree has no `node_modules` (dependencies never installed) and a full `npm install` was intentionally skipped as too slow for this pass, so `vitest`/`tsc`/`lint`/`build` below were **not executed** — do not read this rollout as a green test run:

```bash
npx vitest run test/scheduler-tick-watchdog.test.ts test/scheduler-tick-reentrancy.test.ts test/sentry-inert.test.ts test/scheduler-leader-heartbeat.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

What was actually verified pre-merge: `node --experimental-strip-types --check` (Node 26) parsed `src/lib/scheduler.ts` and all three touched test files clean (exit 0) after the merge — confirms no structural/brace damage from the merge, not a type-check or a real test run.  Manual trace of `test/scheduler-tick-watchdog.test.ts`'s five cases against the merged file confirms the exported surface (`_runSchedulerTickForTest`, `runSchedulerTickWatchdog`, `DEFAULT_TICK_WATCHDOG_MS`, `SENTRY_CRON_MONITOR_SLUG`, and the `__tick*` globalThis fields) is unchanged by the merge, and `test/scheduler-leader-heartbeat.test.ts` (untouched by this branch) still returns before any of the merged code runs on the follower path.  CI's `verify` gate is the first real test execution — auto-merge is armed on that gate, not on this note.

**Real `tsc` failure caught by CI, fixed post-push:** the first CI run (`verify-hosted`) failed `npx tsc --noEmit` — the local syntax check above cannot catch type errors.  Two issues, both fixed:

1. `sendSentrySchedulerCheckIn` built one `payload` object pre-typed as `status: SentrySchedulerCheckInStatus` (a 3-way union of `"in_progress" | "ok" | "error"`) and passed it to the real `@sentry/nextjs` `captureCheckIn`, whose `CheckIn` parameter type is a discriminated union with only two arms (`"in_progress"` vs `"ok" | "error"`).  A pre-widened `status` field cannot structurally match either arm even though every individual call is valid at runtime.  Fixed by branching on `status` first so each call site's object literal narrows to the exact arm.
2. `test/scheduler-tick-watchdog.test.ts`'s `sentryMock.captureCheckIn` was `vi.fn(() => "check-in-id")` — a zero-parameter mock implementation, so vitest inferred its `.mock.calls` element type as an empty tuple, and the test's own `(call[0] as { status: string })` casts failed with "neither type sufficiently overlaps".  Fixed by giving the mock's implementation function real (unused) parameters so `call[0]` infers as `unknown`, which the casts can validly narrow from.

A second CI run after that fix caught a third error the first two masked: the branch-on-`status` fix still forwarded `checkInId` on the `"in_progress"` arm, but the SDK's `InProgressCheckIn` type has no `checkInId` field at all — opening a check-in always mints a fresh ID (returned from the call); only the closing `"ok"`/`"error"` arm can carry one to resume it. Neither production code nor any test ever calls `sendSentrySchedulerCheckIn("in_progress", someId)`, so dropping `checkInId` from that branch is a pure type fix with no behavior change.

Still not executed locally (no `node_modules`) — all three fixes are informed by reading the exact `tsc` error text from consecutive CI runs, not from a local type-check.

## Next Steps & Blockers

- Merge via auto-merge when `verify` is green.  No extra-ship.  No Coolify mutate.  No container restart from this seat.  Weekday RTH latch still applies:  runtime change on `main` builds after the cash close (or with `HOTFIX=1`).
- After deploy:  `scheduler-tick` should show `in_progress` then `ok` every minute; a missed check-in plus `schedulerStale: true` still pages if the loop itself is blocked.
- Do not retry Litestream session `01a0411b`.  Do not touch iOS OAuth (Monet).

## Zero-Code Findings

None.  This is a product-code fix for a hung in-process tick.

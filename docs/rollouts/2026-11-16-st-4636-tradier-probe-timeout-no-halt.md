# ST-4636 — An order-capability probe timeout no longer halts Autopilot on the first strike

## Context & Objective

On the night of Nov 15 to 16, 2026 (7:10pm, 9:12pm and 12:08am CT), production auto-halted the Tradier sandbox account (`becad9f1`) three times.  Every `broker_placement_auto_halted` row carried `category: "order_capability"` and the reason "Tradier order capability probe timed out: The operation was aborted due to timeout".  Each time, `broker_placement_auto_resumed` set it back to active about 2 minutes later, when the next healthy probe ran: the app's own auto-resume path in `applyBrokerOrderPlacementPause`, not a person.  The host was deep in swap with event-loop freezes at the time, so these were local stalls or transient timeouts, not broker outages.  The objective is that one probe that got no answer can never halt the account, while real failures still do.

## Changes Made

Root cause: `TradierBrokerGateway.probeOrderCapability` caught the timeout and returned it as a plain `{ ok: false, reason }`.  `checkBrokerHealth` labels every failed probe `order_capability`, and `applyBrokerOrderPlacementPause` streak-gates only `connectivity`, so a single timeout skipped the 3-in-a-row gate (board 687a5fb4) and halted at once.  Alpaca's probe catch-all had the same shape.  Separately, the 3-count streak alone was too short: Tradier caches a failed probe for 2 minutes and the scheduler ticks every 60s, so one real timeout could read as three failures in a row.

- The probe result type (`OrderCapabilityProbeResult`) gains a structural `transientFailure: "timeout" | "network"`.  Tradier sets it for its `timeout` and `connectivity` categories, including on cached results.  Alpaca sets it for deadline, abort, or timeout errors and for transient network errors.
- `checkBrokerHealth` maps a `timeout` probe to `category: "connectivity"` with `probeTimedOut`, and a `network` probe to `connectivity` with the new `transientConnectivity` flag.  A probe timeout whose window was at least 75% measured event-loop stall becomes the existing `processStall` result: blamed on the app, never counted.
- The connectivity streak now halts only after `BROKER_CONNECTIVITY_HALT_STREAK` (3) consecutive failures that also span `BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS` (10 minutes).  The start time lives in its own internal setting next to the count, and every path that cleared the count clears both.  The halt audit row records the actual streak and span.
- Review round: only fresh broker answers move the streak toward a halt.  Tradier and Alpaca mark probe results served from their in-process cache (`cached: true`, cache pinned on `globalThis`), and `checkBrokerHealth` returns those as `probeResultCached`.  A cached failure skips the tick and refreshes the streak's last-seen time, but never adds to the count or halts.  That also covers a cached copy of a timeout that was blamed on an event-loop stall when fresh, since the cache does not keep the stall attribution.  With Tradier's 2, 4, 8 minute failure backoff, a sustained outage halts at about 14 minutes (fresh failures at 0, 2, 6, 14).
- Review round: a streak with no connectivity-failure tick (fresh or cached) for `BROKER_CONNECTIVITY_STREAK_MAX_GAP_MS` (5 minutes) starts over, tracked in a third internal setting cleared with the other two.  Other unhealthy answers (5xx, low equity, stall) never touch the streak, so an isolated timeout can no longer sit there for hours and pair up with a later one.
- Review round: a sub-threshold connectivity skip (timeout or network, not a process stall) now writes one `skipped_broker_unhealthy` strategy_runs row per skip episode, like low-equity skips, so "why didn't this account trade?" has an answer during the 10-minute window.
- Unchanged: an auth failure, account restriction, `agenticAllowed` false, 5xx order-path failure, an unrecognised probe error, the error-rate gates, and owner halts.  Each unhealthy tick still skips its strategy launch and re-evaluates on the next tick (`schedule.nextRunAt = null`), so no run starts against a dead broker during the 10-minute window.  Order placement is not touched and still fails closed if the broker is unreachable at order time.

Files:

- `src/lib/types.ts`
- `src/lib/execution-mode.ts`
- `src/lib/broker-health.ts`
- `src/lib/tradier.ts`
- `src/lib/alpaca.ts`
- `src/lib/robinhood.ts`
- `test/broker-probe-timeout-no-halt.test.ts` (new)
- `test/helpers/connectivity-streak.ts` (new)
- `test/broker-health-probe-resilience.test.ts`, `test/autonomy-halt-cause.test.ts`, `test/transient-network-resilience.test.ts`, `test/tradier.test.ts`
- `STATUS.md`, `PLAN.md`

## Decisions & Trade-offs

- A time span, not only a bigger count.  A count cannot tell a cached answer from a fresh one; ten minutes of unbroken failure is at least three fresh Tradier probes under its 2, 4 and 8 minute failure backoff.
- The halt is only state: while unhealthy, every tick already skips launching a run.  Waiting ten minutes before writing `halted` does not let a run start against a broker that is down.
- The start-time key is separate from the count key so the count keeps its plain-number shape for existing readers and tests.  A count left by an older build with no start time starts its window at the next failure.
- Tests that drive three failures back to back backdate the streak start with `backdateConnectivityStreak`, the way production ticks minutes apart would.
- No change to the scheduler's skip-and-retry-next-tick behaviour; it already defers rather than consuming the cadence.

## Verification State

- `npx tsc --noEmit -p .` — exit 0.
- `npx eslint` on the touched source and test files — 0 errors (warnings are pre-existing).
- `npx vitest run test/account-mutation-pr2-strategy-loop.test.ts test/autonomy-halt-cause.test.ts test/broker-health-auto-pause.test.ts test/broker-health-probe-resilience.test.ts test/console-brokers-account-visibility.test.tsx test/dashboard-halt-cause.test.ts test/ops-account-control.test.ts test/scheduler-halt-cause-tick.test.ts test/scheduler-sqlite-busy.test.ts test/scheduler-tick-reentrancy.test.ts test/tradier.test.ts test/transient-network-resilience.test.ts test/broker-probe-timeout-no-halt.test.ts` — 13 files, 209 tests, all passed.
- `npx vitest run test/scheduler-lane-observability.test.ts` — 14 passed.
- Full `npm test` and `npm run build` are left to CI `verify`.
- Production evidence was read-only (`sqlite3 -readonly` SELECT on `audit_events`); no production state was changed.

## Next Steps & Blockers

- After deploy, a timed-out probe should show up as a `broker-health-gate` "suppressed" journal row without a `broker_placement_auto_halted` row.  A halt should only follow ten minutes of unbroken connectivity failure.
- The underlying host swap and event-loop stalls are tracked separately (ST-4635 and the watchdog change).

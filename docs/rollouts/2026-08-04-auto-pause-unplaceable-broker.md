# Auto-pause strategy runs when broker cannot place orders

## Context & Objective

Owner: if an account cannot place orders (e.g. Tradier paper OMS returning HTTP 500
"communicating with the backend"), future strategy runs should auto-pause even while the
account is marked running, so LLM/strategy budget is not spent minting unplaceable proposals.

Research showed Tradier sandbox balances/profile/quotes work while **order preview and place
always 500**; live Tradier order path still works. Prior `checkBrokerHealth` only skipped a
single tick and never flipped `systemState`, so cadence kept attempting full runs once other
gates passed (and placement failures did not sticky-pause autonomy).

## Changes Made

- **`checkBrokerHealth`** now:
  - Calls optional `BrokerGateway.probeOrderCapability` (throttled ~2 min in-process)
  - Counts `order_place_infrastructure_failed` audits (≥2 / 30 min → unhealthy)
  - Tags failure `category` (connectivity / account / equity / error_rate / order_capability)
- **`applyBrokerOrderPlacementPause`**: when unhealthy and policy is `active` → set
  `systemState: "halted"`, write auto-resume marker, audit `broker_placement_auto_halted`,
  kill_switch notification. When healthy and marker present → auto-resume to `active`,
  audit `broker_placement_auto_resumed`. Owner manual halt (no marker) is never auto-resumed.
- **Probes**:
  - Tradier: 1-share limit **preview** (OMS reachable even if BP error; 5xx/backend = fail)
  - Alpaca: account `trading_blocked` / non-ACTIVE status
  - Test broker: always ok
- **Reactive**: infrastructure place failures audit `order_place_infrastructure_failed`
  (strategy + approval paths)
- Wired into **scheduler** pre-run gate and **strategy** pre-LLM gate

### Files

- `src/lib/broker-health.ts` (rewrite/expand)
- `src/lib/execution-mode.ts` (HealthSignals.category)
- `src/lib/types.ts` (probeOrderCapability)
- `src/lib/tradier.ts`, `src/lib/alpaca.ts`, `src/lib/robinhood.ts` (Test probe)
- `src/lib/strategy.ts`, `src/lib/strategy-execution.ts`, `src/lib/scheduler.ts`
- `test/broker-health-auto-pause.test.ts`

## Decisions & Trade-offs

- **Halt (not close_only)** for order-path failure: strategy loop refuses non-manual runs when
  halted; protective exits still follow `protectWhileHalted` if set.
- **Auto-resume** when our marker is present — avoids permanent stuck halt after broker recovery.
  Manual Stop has no marker and is not auto-resumed.
- Probes are **preview / flags only** — never submit a real order.
- 2-minute probe TTL avoids hammering Tradier on every scheduler tick.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/broker-health-auto-pause.test.ts
```

Both green (6/6 tests).

## Next Steps & Blockers

- After deploy: Tradier sandbox still OMS-broken broker-side — expect auto-halt of that account
  until Tradier paper trading recovers; then auto-resume.
- Optional: UI badge "paused: broker order path" when marker present (not in this PR).

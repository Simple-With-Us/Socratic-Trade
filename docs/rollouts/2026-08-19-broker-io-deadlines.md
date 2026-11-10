# Broker I/O deadlines + scoped order history

## Context & Objective

Part II cluster `broker-io-deadlines` from `docs/reviews/2026-08-18-full-app-expert-review.md`: Alpaca quotes/place/cancel and Tradier fetch had no HTTP deadline; stop-monitor and stale-limit scheduler lanes only cleared their in-flight keys in `.finally()` with no outer `withDeadline`, so one hung socket latched the lane forever.  Default `getEquityOrders` walked lifetime `status:"all"` pagination on ~20 call sites.

## Changes Made

- Added `ALPACA_BROKER_IO_DEADLINE_MS` (30s), `TRADIER_BROKER_IO_DEADLINE_MS`, and `GetEquityOrdersOptions` (`since`, `fullHistory`) in `src/lib/inflight-deadline.ts` / `src/lib/types.ts`.
- **Alpaca** (`src/lib/alpaca.ts`): inner `trackHealth` deadlines on quotes, place, cancel, option place, nested-order GET; default `getEquityOrders` = open + closed since 24h; `fullHistory: true` retains legacy `status:"all"` walk.
- **Tradier** (`src/lib/tradier.ts`): `AbortSignal.timeout` on every REST fetch; default order list capped at 5 pages with client-side open + 24h terminal filter; `fullHistory` keeps 50-page walk.
- **Scheduler** (`src/lib/scheduler.ts`): `withDeadline(..., SCHEDULER_BROKER_TIMEOUT_MS)` on stale-limit-scan and synthetic-stop-monitor lanes so `.finally()` always runs.
- **Safety maintenance** (`src/lib/safety-maintenance.ts`): export `SCHEDULER_BROKER_TIMEOUT_MS`.
- Stub gateways: optional `GetEquityOrdersOptions` on `webull.ts`, `etoro.ts`, `public-broker.ts`, `robinhood.ts`.
- Tests: `test/broker-io-deadlines.test.ts`; Tradier envelope test uses `fullHistory: true` (terminal filled order outside 24h window).

Touched files:

- `src/lib/inflight-deadline.ts`
- `src/lib/types.ts`
- `src/lib/alpaca.ts`
- `src/lib/tradier.ts`
- `src/lib/scheduler.ts`
- `src/lib/safety-maintenance.ts`
- `src/lib/webull.ts`, `src/lib/etoro.ts`, `src/lib/public-broker.ts`, `src/lib/robinhood.ts`
- `test/broker-io-deadlines.test.ts`
- `test/tradier.test.ts`

## Decisions & Trade-offs

- `ALPACA_BROKER_IO_DEADLINE_MS = 30_000` deliberately exceeds the existing 16s+8s read retry window so `awaitWithFirstCallRetry` wins the race on account reads; writes and unbounded SDK calls get the inner deadline only.
- `withDeadline` lives in `inflight-deadline.ts` (not `safety-maintenance.ts`) so `alpaca.ts` / `tradier.ts` do not circular-import through `broker.ts` → broken health probes in full vitest.
- Default terminal lookback = 24h (`EQUITY_ORDERS_TERMINAL_LOOKBACK_MS`).  Callers needing lifetime history must pass `{ fullHistory: true }` explicitly.
- Scheduler lane timeout stays 15s (`SCHEDULER_BROKER_TIMEOUT_MS`), matching existing safety-maintenance pattern — not a new invented number.
- Out of scope (separate clusters): scheduler tick re-entrancy guard, trade-updates stream idle watchdog, order-replacement provenance.

## Verification State

```bash
npm run lint          # 0 errors (778 warnings, grandfathered)
npx tsc --noEmit      # pass
npm test -- test/broker-io-deadlines.test.ts test/tradier.test.ts  # 64/64 pass
npm test              # full suite (run before merge)
npm run build         # run before merge
```

## Next Steps & Blockers

- Merge after full `npm test` + `npm run build` green on CI.
- If a product surface needs >24h terminal order history (e.g. full orders audit UI), opt in with `{ fullHistory: true }` at that call site only.

## Zero-Code Findings

None.

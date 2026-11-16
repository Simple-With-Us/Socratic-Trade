# 2026-06-30 - Alpaca Held Order Exit Guard and Order Lifecycle

## Summary

Fixed broker-backed sell/cover placement so the strategy blocks duplicate exits
when an existing broker order already reserves the shares. The guard runs before
autonomous placement and before manual proposal approval.

Also clarified broker order lifecycle and stale limit handling. Broker-submitted
orders now display as `Submitted` / `Working` until broker/fill truth says they
executed, broker-paper pending fills do not count in paper P&L/projection until
filled, and broker-backed limit or stop-limit orders can alert after a
customizable threshold (`staleLimitOrderMinutes`, default 15 minutes).

Added guarded market replacement for stale working limit orders. Activity now
shows a `Market replace` action only after the order crosses the stale threshold;
the server cancels the original, re-reads broker state, and submits a market
order for only the remaining quantity once the original order is no longer
active. Live Brokerage replacement requires typed `REPLACE LIVE <SYMBOL>`
confirmation before the cancel request is sent.

## Why

Production KO approval failed on Alpaca Paper with:

- proposal `1463a40c-f41b-4530-b203-60be7fcdaa81`
- run `7a2b9237-297e-44a9-b7cc-fe161a41d189`
- account `PA33IDTHMFK9`
- requested KO sell quantity `17`
- Alpaca error `40310000`: `existing_qty=29`, `held_for_orders=29`, `available=0`
- related held order `2a6ae4c7-c7d3-450c-a9c0-7a9a6a9099e5`

The related order was a broker-held KO bracket sell leg from the prior KO buy
order, so the app's prior check `sell quantity <= position quantity` was
insufficient. Broker availability was actually `position quantity - open/held
sell orders`.

The same incident made the UI ambiguity visible: Alpaca Paper can accept an
order without executing it immediately, especially with limit orders. A broker
order being submitted is materially different from a fill hitting the portfolio,
so the app now treats broker state and fill reconciliation as separate display
and accounting facts.

## Files

- `app/api/policy/route.ts`
- `app/api/orders/replace-market/route.ts`
- `app/dashboard-client.tsx`
- `src/lib/broker-held-orders.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/defaults.ts`
- `src/lib/notifications.ts`
- `src/lib/order-replacement.ts`
- `src/lib/performance.ts`
- `src/lib/scheduler.ts`
- `src/lib/stale-limit-orders.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `test/broker-held-orders.test.ts`
- `test/dashboard-feed.test.ts`
- `test/order-replacement.test.ts`
- `test/performance.test.ts`
- `test/policy-notification-events.test.ts`
- `test/stale-limit-orders.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-06-30-alpaca-held-order-guard.md`

## Verification

- `npm ci` - passed.
- `npx vitest run test/broker-held-orders.test.ts` - passed, 6 tests.
- `npx vitest run test/broker-held-orders.test.ts test/stale-limit-orders.test.ts test/dashboard-feed.test.ts test/performance.test.ts test/policy-notification-events.test.ts` - passed, 5 files / 63 tests.
- `npx vitest run test/order-replacement.test.ts` - passed, 1 file / 3 tests.
- `npx vitest run test/order-replacement.test.ts test/stale-limit-orders.test.ts test/broker-held-orders.test.ts` - passed, 3 files / 11 tests.
- `npx vitest run test/persistence-notification.test.ts -t "writes one strategy_run audit event from runStrategyOnce|records a failed Green Team LLM step when the proposal request times out"` - passed. The prior full `npm test` attempt failed only on those two timeout-sensitive tests (1 file failed, 163 passed; 1569 tests passed).
- `npm run lint` - passed with 0 errors and 254 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 165 files / 1574 tests.
- `npm run build` - passed.
- `rg -n "source === \"paper\"|pending_reconciliation|executionMode === \"test/local\"|filled" src/lib/performance.ts test -g '*.ts'` - typo run with an unquoted shell glob failed under zsh during exploration; no files changed.

## Follow-ups

- Consider parsing broker-native available/held position fields if Alpaca or
  another broker exposes them consistently. The current guard uses the existing
  portable position + open-order data already available through `BrokerGateway`.

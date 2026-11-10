# 2026-08-13 — Kalshi + Exit Contract Phase B shorts + Alpaca paper options

## Summary

First ship of the owner-directed Kalshi / exits / shorts / options vertical slice.
New branch `grok/st-kalshi-exits-options`. Does not touch open PRs #2687 #2689 #2691 #2692.

## What is live vs flagged off

**On when the existing owner gates are on:**

- Exit Contract type + fill-time persistence (already on main: `resolved_stop_pct`,
  `stop_price`, invalidation substrate).
- Broker-held **buy-stops for shorts on Alpaca** when `shortSellingEnabled` is on
  (`brokerStopsForShorts` default **on**). Places a GTC cover stop above entry.
  Native trailing is side-aware. Robinhood / unofficial Webull stay out.
- Unmanaged-short honesty: banner on Home + Guardrails when shorts are off, when
  the venue cannot hold a cover stop, or when the buy-stop lane is off.

**Shipped but default-off (enablement backlog):**

- Options place/cancel on **Alpaca paper** — `optionsTradingEnabled` default off.
  Live option money also requires `optionsLiveOrdersEnabled` (default off).
- Kalshi **macro prompt context** — `KALSHI_CONTEXT` default on, but inert without
  `KALSHI_ENV=demo|prod`. Public market data only.
- Kalshi **event-contract trading** — separate module. Dry-run unless BOTH
  `KALSHI_LIVE_ORDERS=on` **and** `kalshiLiveOrdersEnabled`. Kill switch defaults OFF.

## Files

- `src/lib/protective-stop-math.ts` + `broker-protective-stops.ts` short lane
- `src/lib/option-orders.ts` + Alpaca `placeOptionOrder` / `cancelOptionOrder`
- `src/lib/kalshi-macro.ts` + `src/lib/kalshi-trading.ts`
- Guardrails fields, source-settings knobs, strategist `eventMarkets` block
- Tests: `test/protective-stop-math.test.ts`, `test/option-orders.test.ts`,
  `test/kalshi-macro.test.ts`, `test/kalshi-trading.test.ts`, short buy-stop
  cases in `test/broker-protective-stops.test.ts`

## Verify

Targeted vitest + `tsc --noEmit` on this worktree before PR.

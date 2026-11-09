# 2026-06-23 — RH broker-held stops, Alpaca price-event producer, SPY-benchmark scoreboard

## Summary
The three deferred follow-ups from the Antigravity cheap-wins round (#106), built on top of the
Codex bundle (#113) + execution-mode-safety (#109) + multi-user-auth (#110) changes after a full
review of those.

1. **True broker-held protective stops for Robinhood** (`#1`). Robinhood's MCP can't hold a native
   OCO bracket (unlike Alpaca), so a held position was protected only by the synthetic
   scheduler-tick monitor — a SPOF if the app is offline. New `src/lib/broker-protective-stops.ts`
   `reconcileBrokerProtectiveStops()` places a resting broker-side **stop-market SELL (GTC)** at
   `riskRules.stopLossPct` below entry for each open Robinhood LIVE long, and cancels it when the
   position closes or a synthetic exit fires (no orphaned stop can sell shares we no longer hold).
   Runs from the synthetic-stop monitor each tick (self-heals: re-places missing stops on restart).
   New `broker_protective_stops` table + CRUD (`db-api-keys.ts`); RH `cancel_equity_order` +
   `stop_price` already existed. **DEFAULT OFF** behind `policy.robinhoodBrokerStops` — the exact RH
   MCP stop semantics should be verified against a live account first, and the synthetic monitor
   remains the always-on fallback. Purely additive: when off, zero behavior change.

2. **Alpaca real-time price event-trigger producer** (`#2`). New
   `src/lib/streams/alpaca-price-events-stream.ts` subscribes to Alpaca minute bars for the union of
   active users' explicit symbols (watchlist + additionalSymbols, capped to respect the free IEX
   subscription limit — excess logged, never silently dropped), runs a pure deterministic filter
   (`evaluatePriceSignal`: prior-day-high break / ≥X% intraday move / volume spike), and on a hit
   calls `submitMaterialEvent(userId, {type:"technical", …})` for each active user watching that
   symbol — firing a fresh decision cycle instead of waiting for the scheduled tick. One shared
   connection on the operator market-data key (market data is identical per user); all gating
   (systemState, market hours, cooldowns, caps) is inherited from the trigger engine. Wired into
   `startStreams()`. **DEFAULT OFF** (`STREAMS_ALPACA_PRICE_EVENTS_ENABLED`); also inert unless
   `TRIGGER_ENGINE=1`. This is the missing live-price input source for the event engine that #96
   already built for TradingView.

3. **SPY-benchmark equity-curve scoreboard** (`#3`). New `src/lib/benchmark.ts` compares the
   account's equity curve (portfolio snapshots) to a SPY buy-and-hold over the same window, both
   normalized to 100 at the first common date, with carry-forward alignment for non-trading-day
   snapshots. SPY closes come from the key-free history cascade (`fetchDailyOHLC("SPY")`). Surfaced
   in `getDashboardSnapshot` (`performance.benchmark`) for the active execution mode's curve and
   rendered as a compact "+X% vs SPY (you … / SPY …)" line under the equity chart. The honest
   "are we beating the market" readout — it's measurement, not alpha. Degrades to nothing on sparse
   history or a SPY fetch failure (never throws into the dashboard).

## Why
These were the explicitly-deferred items from #106 / the memory backlog. The meta-point ("is there
edge?") isn't a feature you can code — #3 builds the scoreboard so it can finally be *measured*.

## Files
- NEW `src/lib/broker-protective-stops.ts`, `src/lib/streams/alpaca-price-events-stream.ts`, `src/lib/benchmark.ts`.
- `src/lib/types.ts` — `BenchmarkComparison`/`BenchmarkSeriesPoint` + `PerformanceSummary.benchmark`; `TradingPolicy.robinhoodBrokerStops`.
- `src/lib/db.ts` — `broker_protective_stops` table (migrate baseline).
- `src/lib/db-api-keys.ts` — `BrokerProtectiveStop` + CRUD; account-delete cascade.
- `src/lib/account-deletion.ts` — cascade table list.
- `src/lib/synthetic-stops.ts` — reconcile broker protective stops each tick + cancel-on-synthetic-exit.
- `src/lib/streams/index.ts` — start the price producer.
- `src/lib/dashboard.ts` — attach the SPY benchmark.
- `src/lib/defaults.ts` — `robinhoodBrokerStops: false`.
- `app/dashboard-client.tsx` — "vs SPY" readout.
- `.env.example` — price-producer env + RH-stop note.
- Tests: `test/broker-protective-stops.test.ts`, `test/alpaca-price-events.test.ts`, `test/benchmark.test.ts`.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 957 passed (110 files); +20 new.
- `npm run build` — green.
Built in isolated worktree `~/apps/trading-ag6` off `origin/main`; landing via PR.

## Follow-ups
- Verify the Robinhood MCP stop-order type string ("stop_market") against a live account, then flip
  `policy.robinhoodBrokerStops` on. Consider take-profit + partial-fill handling for RH stops.
- Price producer: dynamic re-subscribe when a user's watchlist changes mid-session (currently the
  watched set is computed at start); SIP feed for sub-second latency.
- Benchmark: TWR / invested-capital normalization so deposits/withdrawals don't distort the curve;
  optional overlay of the SPY curve on the equity chart itself (currently a text readout).

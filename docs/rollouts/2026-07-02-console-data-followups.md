# 2026-07-02 — Console data follow-ups (orders limit/stop/TIF, congress disclosure cap, summary factor fields, Turbopack dev fix)

Branch: `claude/console-data-followups` (Claude). Four small verified-open follow-ups
from the mined backlog, implemented together in one lane.

## Summary

1. **Orders: limit/stop price + time-in-force surfaced end-to-end.** `EquityOrder`
   (`src/lib/types.ts`) gained optional `limitPrice`, `stopPrice`, `timeInForce`
   (raw broker string — Alpaca reports "day"/"gtc"/"ioc"/…, wider than our order-INPUT
   `TimeInForce` union). Populated in `mapAlpacaOrder` (from `limit_price`/`stop_price`/
   `time_in_force`) and the Robinhood MCP `getEquityOrders` mapper (from `price` — Robinhood's
   limit field — `stop_price`, `time_in_force`). `/console/orders` now renders a
   "Limit / Stop" column (stop-limit shows both), a limit-vs-latest-scan-price gap under
   Last price, and TIF columns in both the open-orders and finished-orders tables. The
   stale tooltip disclaimer claiming "broker order data carries no limit price" is gone.
2. **Snapshot congress cap is disclosure-date ordered.** The smart-money congress slice in
   `src/lib/dashboard.ts` now sorts by `disclosedAt ?? tradedAt` (extracted as exported
   `sliceCongressByDisclosure(trades, cap=12)`), so the 12-row cap keeps the most-recently
   DISCLOSED trades. The now-stale comment in `app/console/scan/smart-money.tsx` was
   rewritten; its defensive client re-sort (same key) stays.
3. **Factor fields carried into `MarketQuoteSummary`.** Added optional `factorBreakdown`,
   `headlines`, `intradayChangePct`, `volume` (copied only when > 0), `sectorRelStrength`
   to the summary tier (`src/lib/types.ts`) and copied them from the full quote in
   `quotesBySymbol()` (`src/lib/market.ts`). `toQuoteView` (`app/console/ui/drilldown-data.ts`)
   reads all five from the merged `full ?? summary` quote, so the drilldown can render
   factor bars for symbols outside `topCandidates`; `marketCap` remains full-tier-only.
   Provenance: `EnrichmentSources` already covers `intradayChangePct`/`volume`; `headlines`
   stays unsourced (matches `MarketQuote`).
4. **Turbopack dev 500 fixed.** `@source not "../docs";` added to `app/globals.css` right
   after `@import "tailwindcss";` — Tailwind v4's class scanner was picking up literal
   `shadow-[var(--shadow` + `*` + `)]` snippets in rollout notes as class candidates and the
   generated CSS failed to parse, 500ing every `next dev` (Turbopack) route. The two
   remaining live literals in `docs/rollouts/2026-07-01-ux-ia-aesthetics.md` and
   `docs/rollouts/2026-07-02-console-learned-context.md` were defused with the lookalike-✱
   pattern already used by `docs/rollouts/2026-07-02-console-ground-up-ui.md`.

## Why

All four were verified open against `origin/main` (da07d4bc) on 2026-07-02: the orders
screen explicitly disclaimed data the brokers actually return; the congress cap could drop
a freshly disclosed older trade (the actionable one); summary-tier quotes silently lost the
factor fields the drilldown wants; and default `npm run dev` was unusable (500 on every
route) purely because of documentation literals.

## Files

- `src/lib/types.ts` — `EquityOrder` +limitPrice/stopPrice/timeInForce; `MarketQuoteSummary` +5 factor fields
- `src/lib/alpaca.ts` — `mapAlpacaOrder` populates the three new fields
- `src/lib/robinhood.ts` — Robinhood `getEquityOrders` mapper populates them; comment on `TestBrokerGateway.getEquityOrders` (instant fills — deliberately no resting orders, nothing to populate)
- `app/console/orders/page.tsx` — Limit/Stop + TIF columns, limit-gap subline, tooltip fixes, history TIF
- `src/lib/dashboard.ts` — `sliceCongressByDisclosure` (exported) replaces inline trade-date sort
- `app/console/scan/smart-money.tsx` — comment updated (server cap now disclosure-ordered)
- `src/lib/market.ts` — `quotesBySymbol()` copies factorBreakdown/headlines/intradayChangePct/volume/sectorRelStrength
- `app/console/ui/drilldown-data.ts` — `toQuoteView` reads the five fields from either tier
- `app/globals.css` — `@source not "../docs";`
- `docs/rollouts/2026-07-01-ux-ia-aesthetics.md`, `docs/rollouts/2026-07-02-console-learned-context.md` — literals defused
- `test/alpaca-order-mapping.test.ts` — limit/stop/TIF mapping + omitted-fields assertions
- `test/robinhood-mcp.test.ts` — getEquityOrders mapping test (price→limitPrice, stop, TIF)
- `test/dashboard-smart-money-slice.test.ts` — NEW: disclosure-ordered cap + default-12 + no-mutation
- `test/market-custom-symbol.test.ts` — summary tier mirrors full quote's factor fields
- `test/console-drilldown.test.ts` — factor bars from a summary-only quote; marketCap stays full-only

## Verification

- `npm run lint` — 0 errors, 295 grandfathered warnings
- `npx tsc --noEmit` — clean
- `npm test` — 238 files / 2357 tests, all passed
- `npm run build` — green
- Turbopack check: `npm run dev -- --port 4987` → Ready in 1.3s; `GET /` 200,
  `GET /console/orders` 200 (previously 500 on every route); server killed after.

## Follow-ups

- `TestBrokerGateway.getEquityOrders` returns `[]` by design (Test fills simulate
  instantly, orders never rest) — the scoped "populate Test gateway" sub-item had
  nothing to populate; documented in-code instead.
- The legacy dashboard's orders table (`app/dashboard-client.tsx`) was NOT extended
  with the new fields — console is the going-forward surface; extend there if the
  legacy table outlives the console migration.
- Robinhood TIF values are `gfd`/`gtc`; Alpaca adds `ioc`/`fok`/`opg`/`cls` — the
  console TIF tooltip map covers all of these, unknown values fall back to a generic
  tooltip with the raw value uppercased.

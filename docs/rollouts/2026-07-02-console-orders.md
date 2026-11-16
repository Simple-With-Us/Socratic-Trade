# 2026-07-02 — /console/orders: open orders, stale-limit detection, replace-at-market (Wave 2)

Branch `claude/console-orders` (cut from `origin/main` @ 48fbe14, after the Wave-1
foundation #321 landed). One of the parallel Wave-2 agents; this lane owns ONLY
`app/console/orders/**` plus these handoff docs — no shared console files, no
`src/lib/*`, no API routes were touched.

## Summary

New Orders destination at `/console/orders` (the nav already linked it since #321):

- **Open orders table** — working orders at the broker for the ACTIVE account:
  symbol (`SymbolButton` + logo + company name), side, type, size (share qty or
  ~$ notional, with "X filled · Y left" for partials), last-scan price, age
  (humanized, exact on hover), broker state chip, and per-row actions. Header
  carries the money-reality chip (TEST/PAPER/LIVE · practice/real money) and the
  active-account label; a note explains scoping when multiple accounts exist.
- **Stale-limit detection** — mirrors the SERVER's rule exactly
  (`listStaleLimitOrders` in `src/lib/stale-limit-orders.ts`): a limit or
  stop-limit order in a working state with an unfilled remainder, older than
  `policy.staleLimitOrderMinutes` (default 15; 0 disables). Stale rows get a
  soft amber row tint + a "stale Xm" warn chip whose tooltip says plainly it is
  a heuristic ("the market has likely moved away from the limit price"), plus a
  non-alarmist summary banner when any row is stale. Age-based mirroring is
  deliberate: the same rule gates `POST /api/orders/replace-market` server-side,
  so the UI only offers Replace where the server would accept it.
- **Replace at market** — per-row action on stale rows opening a confirm sheet
  that restates the exact server behavior (cancel the working limit → re-check
  the broker → submit ONLY the remaining shares as a market order, gfd, regular
  hours; "no price cap" stated). On LIVE money the sheet takes the `tone="live"`
  treatment and runs the server's typed-confirmation ritual (`REPLACE LIVE
  <SYMBOL>`, paste disabled, 409 `live_confirmation_required` reasons +
  `expectedText` rendered verbatim — same pattern as the approval card's
  LiveApproveSheet; the approve contract itself is untouched). Success toasts
  distinguish `replaced` (order id + broker state) from `already_filled`.
  Button disabled with honest tooltips while not-yet-stale (shows when it will
  unlock), while Stopped (server 409 `system_stopped` — verified live), and in
  Test mode (server 400).
- **Cancel** — per-row action on every working order via the pre-existing
  `POST /api/orders/cancel`; confirm sheet states fills-already-made stand and
  that cancels are risk-reducing (no typed phrase — the server requires none,
  and cancels stay available while Stopped by design; see the comment on
  `withLivePreflight` in `src/lib/broker.ts`).
- **Recent finished orders** — latest 20 terminal orders (avg fill price,
  final state, updated time) so the destination covers the nav's "order history
  and open orders" promise; points at Activity for the full story.
- **Resilience/UX standard** — tooltips on every column header, cell, chip,
  and action (native `title` floor); row hover automatic via `.con-table`;
  light + dark via `--con-*` tokens only (no new global CSS); mobile via
  `overflow-x-auto`; honest empty states (Test mode explains why nothing ever
  rests here); ages tick client-side every 30s between snapshot polls; errors
  surface as toasts / the chrome's freshness strip, never a crash.

## Why

Wave-2 parity port: legacy buried open orders inside the dashboard Activity feed
(`staleLimitReplaceCandidate` + `MarketReplaceModal` in `app/dashboard-client.tsx`)
with no dedicated view, no cancel UI at all, and the replace affordance only
appearing after an order was already stale. The console destination makes working
orders a first-class screen, keeps the stale rule bit-identical to the server so
UI affordances and server acceptance can't drift, and adds the missing cancel flow
against the endpoint that already existed.

## Where the data actually comes from (findings)

- Open orders are `snapshot.orders: EquityOrder[]` on the dashboard snapshot
  (`GET /api/dashboard` → `src/lib/dashboard.ts` → `gateway.getEquityOrders(accountNumber)`),
  scoped to the active account. A standalone `GET /api/orders` exists but the
  console's single-poll data layer already carries the same array.
- `EquityOrder` carries **no limit price and no time-in-force** — both broker
  mappings drop them (`mapAlpacaOrder` in `src/lib/alpaca.ts`, the Robinhood
  mapping in `src/lib/robinhood.ts`). The requested "limit price vs current
  price gap" column therefore cannot be shown honestly yet; the page shows the
  last-scan price with a tooltip saying exactly that, and the gap is a follow-up
  (below). No fabricated numbers, per repo rule.
- The Test gateway returns `[]` from `getEquityOrders` (simulated fills are
  instant), so Test mode legitimately never has open orders — the empty state
  says so.

## Files (exact)

- `app/console/orders/page.tsx` (NEW) — the destination.
- `app/console/orders/lib.ts` (NEW) — pure derivations mirroring
  `src/lib/stale-limit-orders.ts` / `src/lib/order-replacement.ts` (constants
  annotated with their source of truth; `isActiveBrokerOrderState` imported from
  `@/lib/broker-held-orders`, which is client-safe).
- `app/console/orders/api.ts` (NEW) — self-contained typed fetch helpers for the
  two mutations (deliberately NOT added to the shared `app/console/lib/api.ts`,
  which a parallel agent owns).
- `app/console/orders/replace-market-sheet.tsx` (NEW) — replace confirm sheet
  incl. LIVE typed-confirmation.
- `app/console/orders/cancel-sheet.tsx` (NEW) — cancel confirm sheet.
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-orders.md` (this note).

## Verification (commands actually run)

```bash
npx tsc --noEmit      # clean
npm run lint          # 0 errors, 284 grandfathered warnings (none in new files)
npm test              # 2241 tests / 234 files, all pass
npm run build         # ok; /console/orders present in the route manifest
# runtime smoke (next start -p 3456):
#   GET /console/orders → 200
#   GET /api/dashboard  → orders: [] (Test account), as expected
#   POST /api/orders/replace-market {"orderId":"nonexistent"} → 409 {"error":"system_stopped", ...}
```

The known pre-existing `test/alternative-data.test.ts` mockFetcher/URL tsc issue
did not appear (tsc was fully clean).

## Follow-ups / deferred

- **Limit price + TIF on `EquityOrder`** — wire `limit_price`/`stop_price`/
  `time_in_force` through `src/lib/types.ts`, `mapAlpacaOrder`, and the
  Robinhood order mapping so the console can show the actual limit-vs-market
  gap and TIF column. Needs the `src/lib` owner (deliberately untouched here).
- Consider surfacing `snapshot.orders` for non-active accounts (server work) if
  the owner wants a true multi-account orders view; today the snapshot is
  active-account-scoped by design.
- The "Last price" column uses the latest market-scan quote (same source as the
  symbol drilldown) — can be minutes old; a per-symbol live quote endpoint would
  tighten it.

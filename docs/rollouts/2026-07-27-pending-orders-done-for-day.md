# 2026-07-27 — Why Alpaca showed 300+ "pending" orders (and others)

## Context & Objective

Owner asked why Alpaca reported **over 300 pending orders** (and similar on other
brokers). Diagnose from production ops + code paths; fix any counting bug that
inflates "open/pending" from historical broker order lists.

## Changes Made

### Root cause (code)

1. **Alpaca `getEquityOrders` pages `status:"all"`** (intentional — so placement
   reconcile can prove an order was never placed). The list therefore includes
   months of filled/canceled/**`done_for_day`** history, not only live opens.
2. **Orders UI + stale-limit + feed** treated `done_for_day` as a *working*
   state (`EXTRA_WORKING_STATES`). Day orders keep that status forever in
   history, so the open-orders list could show **hundreds of terminal day
   orders as "pending"**. This contradicts `TERMINAL_ORDER_STATES` in
   `app/console/lib/derive.ts`, which already lists `done_for_day` as terminal.
3. **"Others too"** (Robinhood Agentic): not the same bug — ops audit is dominated
   by `order_placement_uncertain` for **stuck OXY `placing` intents** (RH order
   list is non-authoritative, so absence cannot abandon). That trips the broker
   health gate ("3 / 30 uncertainties in 15 min") and skips strategy runs.
4. **Alpaca Paper** also rejects some exits with HTTP 422
   `bracket orders must be entry orders` (symbol **T**) — separate placement bug,
   not the 300+ count.

Infisical `ALPACA_PAPER_*` env keys return **401** against paper-api; production
uses per-account DB credentials, so cloud could not dump live Alpaca open counts
until `?orders=1` lands.

### Code / docs touched

- `src/lib/broker-held-orders.ts` — shared `isWorkingOrderState` / `EXTRA_WORKING_ORDER_STATES` (no `done_for_day`)
- `app/console/orders/lib.ts` — Orders open list uses shared helper
- `src/lib/stale-limit-orders.ts` — stale-limit scan uses shared helper
- `src/lib/dashboard-feed.ts` — pending broker state uses shared helper
- `src/lib/ops-snapshot.ts` — `summarizeBrokerOrderList` + `attachOpsOrderSummaries`
- `app/api/ops/snapshot/route.ts` — `?orders=1` opt-in
- `scripts/fetch-prod-ops-snapshot.sh` — `OPS_SNAPSHOT_ORDERS=1`
- Tests: `test/broker-held-orders.test.ts`, `test/console-orders-lib.test.ts`, `test/ops-snapshot.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- Keep `stopped` / `calculated` as working (still actionable). Only remove
  `done_for_day`.
- Ops order enrichment is **opt-in** (`orders=1`) so routine snapshots stay fast
  (Alpaca may paginate large `status=all` histories).
- Did **not** change Robinhood stale-`placing` abandon policy in this PR (needs
  careful money-path design); documented as follow-up.

## Verification State

```bash
npx vitest run test/broker-held-orders.test.ts test/console-orders-lib.test.ts test/ops-snapshot.test.ts
# 3 files / 30 tests passed
npx tsc --noEmit   # clean
npm run lint       # 0 errors (grandfathered warnings only)
# full npm test + npm run build run before merge claim
```

Post-merge verify on prod:

```bash
OPS_SNAPSHOT_ORDERS=1 OPS_SNAPSHOT_OUT=/tmp/ops-orders.json bash scripts/fetch-prod-ops-snapshot.sh
# Inspect users[].accounts[].orders.{listedCount,liveCount,workingCount,doneForDayCount}
```

## Next Steps & Blockers

1. Merge → auto-deploy; re-fetch `?orders=1` and confirm Alpaca Paper
   `workingCount` ≪ `listedCount` with high `doneForDayCount` if history is large.
2. Follow-up: Robinhood stuck OXY `placing` intents — age-out / manual resolve /
   authoritative list when available.
3. Follow-up: Alpaca sell+bracket → 422 `bracket orders must be entry orders` for T.
4. Owner: set Cursor Cloud `OPS_DIAGNOSTIC_TOKEN` to Infisical prod value (cloud
   secret currently 401s; Infisical path works).

## Zero-Code Findings

- Strategy "Re-checked N pending" means **pending proposals**, not broker open
  orders (N was 2–3 on Alpaca Paper today).
- 63/100 recent ops audits were `order_placement_uncertain` on Agentic (RH).

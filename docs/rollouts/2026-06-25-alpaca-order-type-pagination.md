# Rollout: Alpaca order-type mapping + getEquityOrders pagination

## Summary
Two pre-existing broker-robustness fixes in `src/lib/alpaca.ts` `getEquityOrders` (flagged in
`docs/rollouts/2026-06-24-safety-fixes-a-e.md` follow-ups):

1. **Order-type mapping.** Raw Alpaca order types were cast `o.type as OrderType`, which leaked
   non-union values downstream — Alpaca uses `"stop"` (not our `"stop_market"`) and `"trailing_stop"`.
   New `mapAlpacaOrderType()` maps them: `stop → stop_market`, `trailing_stop → stop_market`,
   `market`/`limit`/`stop_limit` pass through, unknown/absent → `market` (safe default, never leak).
2. **Pagination.** `getOrders({ status: "all" })` returned only Alpaca's default page (≤ the limit,
   newest-first), silently capping order history. The REST fallback now walks backwards via `until`
   (oldest `created_at` seen) in pages of 500, deduping by id, until a short page / no progress
   (guarded at 50 pages = 25k orders). The MCP call now also requests `limit: 500`.

## Incidental fix
The function previously **mapped twice** — the REST fallback pre-mapped to `EquityOrder[]`, then the
`.then` re-mapped, re-reading `o.status` (which is `state` on `EquityOrder`) → `state: "undefined"`.
Now the REST fallback returns **raw** orders and a single `.then` maps via the shared `mapAlpacaOrder`
helper, so REST and MCP paths share one correct mapping.

## Files
- `src/lib/alpaca.ts` — `mapAlpacaOrderType` + `mapAlpacaOrder` helpers (exported); `getEquityOrders`
  paginated + single-mapped.
- `test/alpaca-order-mapping.test.ts` (new).
- `STATUS.md`, this rollout note.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1128/1129 (sole failure = pre-existing `cache-provenance` env flake, unrelated; the
  Alpaca MCP test passes).
- `npm run build` — green.
- New tests cover the type mapping (incl. stop/trailing_stop/unknown) and a full raw→EquityOrder map.

## Note
Pagination loop logic + the mapping are unit-tested, but the live `until`-paging against the real
Alpaca REST API was not exercised here (no live broker in this env). Low risk — the loop is bounded,
deduped, and falls back safely — but worth a sanity check against a real account with >500 orders.

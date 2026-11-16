# Alpaca MCP getEquityOrders must include terminal orders

## Context & Objective

#2886 scoped REST `getEquityOrders` to open orders plus closed orders inside a
24h window so default callers no longer walk `status:"all"`.  The MCP success
path was changed to `get_orders` `{ status: "open" }` at the same time.
`ordersListIncludesTerminal` stayed true.

`reconcilePlacementError` and `flagStalePlacingIntents` treat a missing
`client_order_id` on an authoritative list as never-placed / safe to retry.
A market order that fills (and leaves `open`) before the place deadline
returns is then invisible on MCP and can be submitted again.

## Changes Made

- `src/lib/alpaca.ts` — default MCP `get_orders` uses `status:"all"` (limit 500).
  REST fallback stays open + closed-since.
- `test/alpaca-mcp.test.ts` — MCP default list must request `all` and surface a
  filled order with its `client_order_id`.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

## Decisions & Trade-offs

- Did not add a second MCP call for `status:"closed"`.  `status:"all"` limit 500
  is what the MCP full-history path already uses and is enough to see a fill
  from the current place attempt.
- Did not change `ordersListIncludesTerminal`.  The REST merge already
  justifies it; MCP now matches the contract.
- Did not touch #2960 (createOrder socket retry) or the Tradier paging PRs.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/alpaca-mcp.test.ts test/broker-io-deadlines.test.ts
```

## Next Steps & Blockers

- None for this slice.

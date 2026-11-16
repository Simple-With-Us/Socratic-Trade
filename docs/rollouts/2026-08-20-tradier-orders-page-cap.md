# Tradier getEquityOrders must keep walking past 5 pages

## Context & Objective

#2886 added broker I/O deadlines and scoped default `getEquityOrders` to open + 24h terminal history.  Alpaca did that correctly by fetching `status:"open"` separately.  Tradier has no status split in this adapter, so the same change capped the newest-first pager at 5 pages (~125 rows at Tradier's default 25/page).  A later-page GTC equity protective stop becomes invisible to `liveExitOrderCoverage`; the synthetic-stop monitor then places a duplicate exit.

## Changes Made

- `src/lib/tradier.ts`: default and `fullHistory` both walk up to 50 pages again.  Keep the client-side 24h filter on *terminal* orders only (working orders still return).
- `test/tradier.test.ts`: regression — 5 option-only pages plus a page-6 equity stop must return that stop on the default path.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

Touched files:

- `src/lib/tradier.ts`
- `test/tradier.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-tradier-orders-page-cap.md`

## Decisions & Trade-offs

- Did not add a Tradier `status=open` query.  That filter exists in current docs but is unproven on this adapter; the 50-page walk is the pre-#2886 coverage contract.
- Did not change Alpaca.  Its `status:"open"` + closed-since-24h split already keeps GTC working orders.
- Did not raise scheduler timeouts or revert #2886 deadlines.

## Verification State

```bash
npx vitest run test/tradier.test.ts
# 60/60 pass (includes page-6 equity-stop regression)
npx vitest run test/broker-io-deadlines.test.ts test/synthetic-stops.test.ts test/broker-side.test.ts
# 111/111 pass
npx tsc --noEmit   # pass
npm run lint       # 0 errors (grandfathered warnings)
```

Full `npm test` hung on unrelated env/timeout files (same class as #2854).  Did not run `npm run build` (no Next surface change).

## Next Steps & Blockers

- Review + merge.  No deploy from this seat (main auto-deploys).
- Optional later: fetch Tradier working statuses in a dedicated request, matching Alpaca.

## Zero-Code Findings

None.

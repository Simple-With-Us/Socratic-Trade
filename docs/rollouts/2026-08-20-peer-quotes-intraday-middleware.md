# Peer quotes/intraday 401 at the edge

## Context & Objective

#2953 shipped `/api/market/quotes` and `/api/market/intraday/[symbol]` as
token-gated peer reads for Congress.Trade, using the same `APP_B_INGEST_TOKEN`
path as `/api/market/prices` and `/api/market/spx`.  The edge bearer
pass-through was never extended, so a peer call with only that token is 401
before the handler runs.

## Changes Made

- `middleware.ts` — `isPeerMarketReadPath` includes quotes and intraday.  Flatfile stays session-gated.
- `test/market-read-routes.test.ts` — bearer-without-session pass-through for the two new routes; quotes still 401 with no bearer.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

## Decisions & Trade-offs

- Did not open `/api/market/*`.  Flatfile must stay session-gated.
- Token check stays in the handler via `verifySecuritiesImportToken`.  Middleware only lets the request reach it.
- CT is not wired yet.  Its peer client swallows 401s, so this would fail silent when that follow-up lands.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/market-read-routes.test.ts
npm run lint
```

## Next Steps & Blockers

- None for this slice.  Did not touch #2947 or #2952.

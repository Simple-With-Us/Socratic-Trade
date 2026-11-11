# 2026-11-11 — ST-4602 peer price reads vs SQLite lock (SOCRATIC-TRADE-35)

## Context & objective

Congress.Trade cache-aside pulls were surfacing unhandled `SqliteError: database is locked` as HTTP 500 on `GET /api/market/prices/[symbol]` (Sentry SOCRATIC-TRADE-35).  DEFERRED read-then-write transactions under WAL can upgrade to `SQLITE_BUSY_SNAPSHOT` instantly, bypassing `busy_timeout`.

## Changes made

- Added `src/lib/sqlite-peer-read.ts`: peer-read yield-retry budget, best-effort write helper, 503 + `Retry-After` response helper.
- Switched read-then-write paths to `BEGIN IMMEDIATE`: `history-cache.ts`, `db-securities-import.ts`, `db-settings.ts` (`recordMarketDataDemand`, `fulfillMarketDataDemand`).
- `history.ts`: congress-read labeled fetches use peer sqlite retry; optional writes (audit, demand ledger) are best-effort on peer pulls.
- Peer market routes + securities import return 503 on persistent contention; auth reject audits are best-effort.

Files:

- `src/lib/sqlite-peer-read.ts` (new)
- `src/lib/sqlite-event-loop.ts`
- `src/lib/history-cache.ts`
- `src/lib/history.ts`
- `src/lib/db-settings.ts`
- `src/lib/db-securities-import.ts`
- `app/api/market/prices/[symbol]/route.ts`
- `app/api/market/spx/route.ts`
- `app/api/market/profile/[symbol]/route.ts`
- `app/api/market/quotes/route.ts`
- `app/api/market/intraday/[symbol]/route.ts`
- `app/api/admin/securities/import/route.ts`
- `test/sqlite-peer-read-busy-snapshot.test.ts` (new)
- `test/market-read-routes.test.ts`

## Decisions & trade-offs

- Peer reads use a **4s** yield-retry budget (not the full 60s scheduler budget) so Congress.Trade gets a fast 503 + `Retry-After: 2` instead of hanging.
- Best-effort writes on read paths may drop optional audit/demand rows under extreme contention; price envelopes stay 200/502-stale.

## Verification state

```bash
npx tsc --noEmit
npm run lint
npm test -- test/sqlite-peer-read-busy-snapshot.test.ts test/market-read-routes.test.ts
npm test
npm run build
```

## Next steps & blockers

- Merge after `verify` CI green; watch SOCRATIC-TRADE-35 event rate post-deploy.

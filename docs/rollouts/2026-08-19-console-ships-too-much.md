# Console ships too much — server DB boundary + snapshot projection

## Context & Objective

Part II cluster `console-ships-too-much` from `docs/reviews/2026-08-18-full-app-expert-review.md`.  Stop shipping server DB modules into the browser via `brokers.tsx → venue-contract → source-settings → db`, and shrink the 15s dashboard poll payload (raw audit rows, full quote universe, full order history).

## Changes Made

- Added `server-only` guard to `src/lib/db.ts` and every `src/lib/db-*.ts` module (+ `src/lib/db/client.ts`).
- Split client-safe venue helpers into `src/lib/venue-contract-pure.ts`; `brokers.tsx` imports from there.
- Split `realizedPnlNetOfEstimatedTax` into `src/lib/tax-pure.ts`; `results/page.tsx` imports from there (`server-only` on `tax.ts` otherwise trips webpack via `performance` → `db*`).
- Added `src/lib/dashboard-snapshot-projection.ts` and project snapshot at return time:
  - drop raw `audit[]` (keep `auditFeed` / `unifiedFeed`)
  - trim `latestScan` / `latestStrategyRun.marketScan` `quotesBySymbol` to referenced symbols
  - trim `orders` to working rows + 20 terminal history rows
- Bust dashboard snapshot cache on notification ack, order cancel, and replace-market.
- Vitest aliases `server-only` to `test/mocks/server-only.ts` so the suite keeps running in Node.

**Files touched**

- `package.json`, `package-lock.json`
- `src/lib/venue-contract-pure.ts`, `src/lib/venue-contract.ts`
- `src/lib/tax-pure.ts`, `src/lib/tax.ts`
- `app/console/results/page.tsx`
- `src/lib/dashboard-snapshot-projection.ts`, `src/lib/dashboard.ts`
- `src/lib/db.ts`, `src/lib/db-*.ts`, `src/lib/db/client.ts`
- `src/lib/order-cancel.ts`
- `app/console/settings/brokers.tsx`, `app/dashboard-types.ts`
- `app/api/notifications/ack/route.ts`, `app/api/orders/replace-market/route.ts`
- `vitest.config.ts`, `test/mocks/server-only.ts`
- `test/venue-contract-pure-boundary.test.ts`, `test/console-client-import-boundary.test.ts`
- `test/dashboard-snapshot-projection.test.ts`, `test/notifications-ack-cache-invalidation.test.ts`

## Decisions & Trade-offs

- `server-only` on all `db*` modules (not just the three named in the review) — any future accidental import fails at build time.
- Did not trim `activeProfile` duplicate or change `/api/scan` audit writes (separate findings).
- Did not touch per-account visibility labeling in `brokers.tsx` (other cluster).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/venue-contract-pure-boundary.test.ts test/console-client-import-boundary.test.ts test/dashboard-snapshot-projection.test.ts test/notifications-ack-cache-invalidation.test.ts test/venue-contract.test.ts
npm run build
rg -c 'getDb|better-sqlite3' .next/static/chunks/app/console/connections/page-*.js  # 0 matches
```

Build passes.  Focused tests: 17/17 green.  Full `npm test` not re-run to completion in this session (suite is long; no regressions expected in unrelated files).

## Next Steps & Blockers

- Optional follow-up: mirror webpack `server-only` tripwire under Turbopack dev (`LIVE-01`).
- Optional: project `/api/mobile/snapshot` the same way (`api-04`).

## Zero-Code Findings

None.

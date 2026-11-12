# ST-4630: stale last-good screener profile

## Context & Objective

`GET /api/market/profile/{symbol}` returned 404 `{ ref: null }` for known tickers when the Nasdaq screener timed out, returned a non-OK status, or threw.  Sentry SOCRATIC-TRADE-3M (`congress-nasdaq-screener connection failed`, last seen 2026-11-11T14:07:51Z) is that blip.  The in-process map already refused to cache an empty failure, and it still threw away the last successful rows.

## Changes Made

A failed refresh now returns the last successful map when that map has rows, and it schedules the next live attempt 30 seconds later.  An empty failure is still not written into the 5-minute TTL, so a miss with no prior rows stays null and the next call retries immediately.  `/api/health` provider-timeout classification is unchanged.

- `src/lib/market-read.ts`
- `test/market-read-routes.test.ts`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The stale hold is 30 seconds (`SCREENER_PROFILE_STALE_RETRY_MS`) measured from when the failure returns, short of the 5-minute success TTL.  A two-attempt Nasdaq timeout is about 30 seconds, so a hold measured from fetch start would already be over.  A successful empty screener (HTTP OK, zero rows) still replaces the map and is cached.  The map and the hold live on `globalThis.__marketReadScreenerProfileState`, because Next.js can load this module once per route.  The response body stays `{ ref }` with no stale label.  The last-good map has no age ceiling: the ticket asks for the last successful rows even after the 5-minute TTL.  The request that discovers a failure still waits for that fetch, then the next lookup uses the hold.  No phase doc describes this profile cache.  No dependency was added.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/market-read-routes.test.ts
npm test
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

Node 26.13.1.  Before the fix, the three new cases failed (helper returned null, route returned 404).  After the fix, `npx vitest run test/market-read-routes.test.ts` passed 44/44, including a timeout that burns the 30-second budget before the catch runs.  `npm run lint` exited 0 (0 errors, 869 grandfathered warnings).  `npx tsc --noEmit` exited 0.  `npm test` finished 10251 passed, 41 skipped, 18 failed across 12 files that do not import the profile cache (ambient credentials and an unauthenticated `gh` on this VM).  `test/market-read-routes.test.ts` was not among the failures.  The default `npm run build` aborted at the 2 GB V8 heap.  The same build with `NODE_OPTIONS=--max-old-space-size=4096` exited 0.

## Next Steps & Blockers

Open a ready PR against `main`.  Do not merge, do not enable auto-merge, and do not deploy.  `verify` CI is the merge gate.

## Zero-Code Findings

None.  The behavior change is the profile cache in `loadScreenerProfileMap`.

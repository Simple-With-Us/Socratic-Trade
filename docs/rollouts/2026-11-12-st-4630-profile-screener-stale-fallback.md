# ST-4630: stale last-good screener profile

## Context & Objective

`GET /api/market/profile/{symbol}` returned 404 `{ ref: null }` for known tickers when the Nasdaq screener timed out, returned a non-OK status, or threw.  Sentry SOCRATIC-TRADE-3M (`congress-nasdaq-screener connection failed`, last seen 2026-11-11T14:07:51Z) is that blip.  The in-process map already refused to cache an empty failure, and it still threw away the last successful rows.

## Changes Made

A failed refresh now returns the last successful map when that map has rows no older than 24 hours (`SCREENER_PROFILE_MAX_STALE_MS`), and it schedules the next live attempt 30 seconds later.  When a usable last-good map is already in memory, the live refresh races a 1-second budget (`SCREENER_PROFILE_STALE_SERVE_BUDGET_MS`) and the last-good map is returned if the live request is still running, so the first stale lookup does not wait out two 15-second Nasdaq timeouts.  Concurrent refreshes share one in-flight request.  An empty or over-age failure is still not written into the 5-minute TTL, so a miss with no usable prior rows stays null and the next call retries after the hold.  `/api/health` provider-timeout classification is unchanged.

- `src/lib/market-read.ts`
- `test/market-read-routes.test.ts`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The stale hold is 30 seconds (`SCREENER_PROFILE_STALE_RETRY_MS`) measured from when the failure returns, short of the 5-minute success TTL.  A two-attempt Nasdaq timeout is about 30 seconds, so a hold measured from fetch start would already be over.  A successful empty screener (HTTP OK, zero rows) still replaces the map and is cached.  The map, the hold, and the in-flight refresh live on `globalThis.__marketReadScreenerProfileState`, because Next.js can load this module once per route.  The response body stays `{ ref }` with no stale label.  Last-good rows older than 24 hours (`SCREENER_PROFILE_MAX_STALE_MS`) are not served; the lookup returns null / 404 as it did before this change.  A request that finds expired rows and a usable last-good map starts the live refresh, waits up to 1 second, and returns the last-good map if the refresh is still running.  No phase doc describes this profile cache.  No dependency was added.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/market-read-routes.test.ts
```

Node 26.13.1.  Before the follow-up, the two new cases failed (a hung live refresh did not return the last-good map within the 1-second budget; a map older than 24 hours was still served).  After the follow-up, `npx vitest run test/market-read-routes.test.ts` passed 46/46, including the existing 30-second hold case, the prompt stale-serve case, and the 24-hour max-age case.  `npx eslint src/lib/market-read.ts test/market-read-routes.test.ts` exited 0 with no findings on the changed files.  `npm run lint` exited 0 (0 errors, grandfathered warnings only, none on the changed files after dropping an unused `no-var` disable).  `npx tsc --noEmit` exited 0.


## Next Steps & Blockers

Open a ready PR against `main`.  Do not merge, do not enable auto-merge, and do not deploy.  `verify` CI is the merge gate.

## Zero-Code Findings

None.  The behavior change is the profile cache in `loadScreenerProfileMap`.

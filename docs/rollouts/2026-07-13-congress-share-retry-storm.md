# Rollout Note: P2.4 Congress Share Daily Retry Storm Fix

## Summary
Implemented P2.4 to prevent duplicate daily close / congress data sharing runs and retry storms in the same process.

## Why / Decisions Made
- **Deduplication of In-flight Runs**: If the daily share run is started (which can take some time due to OHLC fetching, flat file range fetches, and individual POST requests to App A), subsequent triggers in the same Node process (e.g. from rapid scheduler ticks or concurrent routes) should not spawn parallel operations. Caching and returning the active promise in a module-level `activeDailySharePromise` variable deduplicates concurrent invocations cleanly.
- **Failure Backoff Verification**: Verified that the existing 60-minute failure backoff in `isCongressDailyShareDue` is active and correct. It prevents retry storms when App A is down or rate limits App B.

## Touched Files
- [src/lib/congress-share.ts](file:///Users/jay/apps/trading-ag-safety/src/lib/congress-share.ts) (Added activeDailySharePromise cache and in-flight promise check)
- [test/congress-share.test.ts](file:///Users/jay/apps/trading-ag-safety/test/congress-share.test.ts) (Added deduplication test case)
- [STATUS.md](file:///Users/jay/apps/trading-ag-safety/STATUS.md) (Updated status)

## Verification
- Run `npx vitest run test/congress-share.test.ts` to verify the deduplication test case -> Passed (40/40 tests)
- Run `npx tsc --noEmit` -> Passed cleanly
- Run `npx vitest run` -> 3930 tests passed

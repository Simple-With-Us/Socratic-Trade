# Rollout Note: 2026-08-02 — Local Flat-File Price History Priority

## 1. Context & Objective
The user directed:
"any data that is in the 5yrs of Massive flat file price history should reference that instead of calling on Massive or any other API (in part so we make sure to use data we have already and are able to backtest and provide EOD prices to Congress.Trade)"

## 2. Changes Made
- **Local Flat-File History Primary Tier (`src/lib/history.ts`)**:
  - Created `fetchLocalFlatFileHistory(symbol)` to check local pre-hoarded 5-year price datasets (`data/history-5y/${symbol}.json`, `data/fmp-history/${symbol}.json`) before any remote API calls.
  - Placed `fetchLocalFlatFileHistory` as the **#1 primary source** in the `fetchDailyOHLC` cascade (`sources` array in `src/lib/history.ts`).
  - When local 5y flat-file history is present for a symbol, `fetchDailyOHLC` serves it directly in <1ms without requesting remote REST APIs (`api.massive.com`, Tradier, Marketstack, etc.).
- **Local Bulk Daily Market Aggregates (`src/lib/market-signals/massive.ts`)**:
  - Updated `fetchGroupedBarsRest(date)` to check local daily market gzipped flat files (`data/massive-history/${YYYY}/${MM}/${date}.json.gz` or `.json`) first.
  - If local flat files exist for the date, bulk daily market breadth and OHLC readings resolve locally without API calls.
- **Congress.Trade EOD Price Bridge Integration**:
  - `src/lib/market-read.ts` (`/api/market/prices/[symbol]` and `/api/market/spx`) delegates to `fetchDailyOHLC`.
  - Congress.Trade (App A) now automatically receives EOD price history served directly from App B's local 5-year Massive flat files without hitting external API rate limits.
- **Tests**:
  - Added unit test in `test/history.test.ts` to verify `fetchLocalFlatFileHistory` serves local JSON datasets without network requests.

## 3. Verification State
- `npx vitest test/history.test.ts test/market-read-routes.test.ts --run` -> 36/36 tests passed.
- `npx tsc --noEmit` -> Passed with 0 errors.

## 4. Files Touched
- `src/lib/history.ts`
- `src/lib/market-signals/massive.ts`
- `test/history.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-08-02-local-flatfile-history-priority.md`

# Market cache freshness — session-aware TTL (mdi-01 / market-cache-freshness)

## Context & Objective

Expert review cluster `market-cache-freshness` (Part II, `docs/reviews/2026-08-18-full-app-expert-review.md`) found calendar-day cache math freezing screener, OHLC, and enrichment caches during live Friday sessions.  This change makes cache TTL extension and EOD bar freshness session-aware so intraday writes keep their naive TTL until the regular session actually closes.

## Changes Made

- `src/lib/market-hours.ts`
  - Added `getEarlyCloses(year)` for half-day closes (day-after-Thanksgiving, Christmas Eve, July 3).
  - Added `latestCompletedTradingSessionEtKey(nowMs)` for session-counted bar freshness.
  - Rewrote `isWeekendOrHolidayClosureAhead` to extend TTL only after today's session close (including early closes).
  - Threaded dynamic close times into `currentMarketSession`.
- `src/lib/history.ts`
  - Replaced 3-calendar-day `isBarSeriesFresh` with trading-session comparison against `latestCompletedTradingSessionEtKey`.
- `test/market-hours.test.ts` — Friday 10:00 ET naive TTL; Friday after close extends to Monday; early-close session boundary.
- `test/flatfile-range.test.ts` — session-counted bar freshness tests.

## Decisions & Trade-offs

- Dropped `maxStalenessDays` from `isBarSeriesFresh` (only caller was `fetchDailyOHLC` in the same file).
- Early-close table covers the three recurring NYSE half-days the review named; ad-hoc one-off early closes are not modeled.
- `expiresAtRespectingMarketClose` still extends across genuine multi-day closures after today's close — unchanged intent, narrower trigger.

## Verification State

```bash
npm run lint          # 0 errors (771 pre-existing warnings)
npx tsc --noEmit      # clean
npx vitest run test/market-hours.test.ts test/flatfile-range.test.ts  # 44 passed
npm test              # 6998 passed (36 unrelated pre-existing failures in other files)
npm run build         # clean
```

## Next Steps & Blockers

- Merge PR; auto-deploy on `main` will pick it up.
- Sibling cluster `quote-value-provenance` (fabricated `asOf` / ask-as-price) remains a separate PR.

## Zero-Code Findings

None.

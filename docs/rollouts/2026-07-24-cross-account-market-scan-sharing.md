# 2026-07-24 — Cross-Account Market Scan Seed Enrichment Sharing

## Context & Objective
The user noticed that switching accounts in the UI resulted in missing fundamental metrics (P/E, EPS Growth, Dividend Yield, Sentiment, Analyst Ratings) for accounts that had not run a recent strategy scan, even though other accounts under the same user had already enriched those exact symbols.

Market fundamentals (P/E, EPS growth, dividends, ratings) are universal to the underlying security and should be shared user-wide across all brokerage accounts.

## Changes Made
- Modified `app/api/scan/route.ts`: Changed `seedEnrichment` lookup to fetch both the active account's strategy run audit (`latestAccountAudit`) AND the user's latest strategy run audit across ANY account (`latestGlobalAudit`). Merged `globalSeed` into `accountSeed` (`{ ...globalSeed, ...accountSeed }`), ensuring fundamental metrics enriched during any recent strategy scan immediately hydrate interactive scans across all user accounts.
- Modified `src/lib/dashboard.ts`: Updated `latestRunAudit` to fall back to the latest user-wide `strategy_run` audit if the active account has no recent strategy run payload.

## Files Touched
- `app/api/scan/route.ts`
- `src/lib/dashboard.ts`
- `STATUS.md`

## Verification State
- Executed `npx tsc --noEmit` -> PASS (0 errors).
- Executed `npx vitest run test/market-preselection.test.ts` -> PASS (7/7 tests passed).

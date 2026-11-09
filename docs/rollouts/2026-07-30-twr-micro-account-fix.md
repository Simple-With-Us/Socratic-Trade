# Rollout: Fix TWR minimum threshold logic

## Context & Objective
The cash flow inference logic had a hardcoded $25 minimum threshold intended to ignore noise (like dividends) on normal portfolios. For a new micro-account starting at $4.63, a $20 deposit is a >400% move that was incorrectly classified as a pure market loss, drastically distorting the account's Time-Weighted Return curve (reporting -53% despite the equity jumping >800%). We lowered the absolute threshold to $0.50 to properly capture small cash flows on micro-accounts.

## Changes Made
- Updated `src/lib/benchmark.ts` to reduce `FLOW_MATERIALITY_MIN_USD` from $25 to $0.50.
- Reverted the well-intentioned but flawed missing-fill guard that ignored decreases in equity when `tradeCash` wasn't perfectly aligned, since this guard was breaking valid stock sales.
- Updated `test/benchmark.test.ts` to accommodate the lowered threshold.
- Fixed a broken database migration test. A previous PR added `pushover_target` to the SQLite DB but didn't write the corresponding migration for the `notification_prefs` table, causing the global test suite to fail on fresh environments. Added migration 63 to append `pushover_target` safely and updated schema version assertions in `test/persistence-hardening.test.ts`.

## Decisions & Trade-offs
A threshold of $0.50 allows us to properly account for micro-deposits while still ignoring literal pennies (rounding errors/cents from interest) that don't need to split the TWR sub-periods. The fallback missing-fill guard was removed entirely as it was too aggressive in neutralizing legitimate capital drawdowns.

## Verification State
- `npm run lint` - passes
- `npx tsc --noEmit` - passes
- `npm test` - passes fully (470 test files, 5431 tests)
- `npm run build` - passes

## Next Steps & Blockers
None. Ready to merge to main.

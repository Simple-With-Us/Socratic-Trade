# 2026-06-22 - robinhood-data-consent-pool

## Summary

Robinhood-acquired **public market data** (daily bars + fundamentals) now flows into the reciprocal
**consent pool** like every other user-keyed data source, instead of being hard-`private` per user.
The RH OAuth token stays strictly per-user (unchanged from PR #54) — only the resulting public data
is shared, and only with consent.

- **Bars** (`src/lib/history.ts`): the Robinhood OHLC tier in `fetchDailyOHLC` was hard-coded
  `scope: "private"`. It now derives its cache scope via `cacheScopeForKeySource("user", userId)` —
  the same logic used for user-keyed Massive/Tradier/Marketstack history: **pool** when the user
  opted into the data pool, otherwise **private** (never force-shared unless
  `MARKET_DATA_SHARE_USER_KEYED_HISTORY` is on).
- **Fundamentals** (`src/lib/data-providers.ts` `RobinhoodEnrichmentProvider`): previously did no
  caching at all. It now uses the same consent-aware `readEnrichmentCache` / `writeEnrichmentCache`
  pattern as the other enrichment providers (Alpaca/Finnhub/etc.), with
  `scope = cacheScopeForKeySource("user", userId)`. A consenting user's RH fundamentals are written
  to the pool and served to other consenters (saving a broker call); a non-consenting user's pulls
  stay private and never reach the pool.

What is pooled is strictly public market data — `pe_ratio`, 52-week high/low, average volume,
sector, industry, and OHLC bars — never the user's account-private info (positions, balances,
orders are not fetched by these read-only enrichment paths).

## Why

Owner direction: Robinhood-acquired info that isn't user-private should feed the consent pool —
"assuming the user agrees to be part of that like all other data sources are or should be." This
closes the one remaining gap where a user-keyed source (RH) was hard-private rather than
consent-pooled. Reciprocity is preserved: contribute (consent) → benefit from the pool; refuse →
private + excluded.

## Files

- `src/lib/history.ts` — RH OHLC tier scope `"private"` → `cacheScopeForKeySource("user", userId)`.
- `src/lib/data-providers.ts` — `RobinhoodEnrichmentProvider` gains `scope` + consent-aware
  read/write caching (mirrors the other providers).
- `test/robinhood-data-pool.test.ts` — NEW (3 tests): consenting users share RH bars + fundamentals
  via the pool (no second broker call); a non-consenting user's pulls stay private.

## Verification

In `~/apps/trading-rh-pool` (branch `feat/robinhood-data-consent-pool`, base `origin/main`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — **807 passed** across 91 files (+3).
- `npm run build` — clean (exit 0).

## Follow-ups

- None. RH bars/fundamentals now behave identically to other user-keyed market-data sources w.r.t.
  the consent pool.

## Blockers

- None.

# 2026-08-03 — Subdomain Routing for Mobile & Console + EOD Quote Caching & Freshness Upgrade

**Agent:** ANTIGRAVITY · branch `agent/antigravity`

## 1. Context & Objective

1. **Subdomain Host-Level Routing**: `mobile.socratictrade.com` (and `mobile.socratic.trade`) and `console.socratictrade.com` (and `console.socratic.trade`) needed host-level routing to `/mobile` and `/console` respectively.
2. **EOD Quote Caching & Freshness Upgrade**: Previously, `fetchLocalFlatFileHistory` returned flat-file bars without checking if the last bar in the file was fresh or stale. When flat files ended on a date weeks prior (e.g. after a data subscription ended), `fetchLocalFlatFileHistory` returned the stale bars directly without querying active providers (Tiingo, Tradier, Marketstack, Yahoo, etc.) to top up recent bars, causing staleness gate holds (`staleness_gate`). Furthermore, when active providers did return fresh bars, they were only held in a short-lived 30-minute in-memory cache and never auto-persisted to SQLite `imported_price_eod` or disk flat files.

## 2. Changes Made

- **`middleware.ts`**:
  - Added host-level routing rules for `mobile.socratictrade.com` / `mobile.socratic.trade` $\rightarrow$ `/mobile` and `console.socratictrade.com` / `console.socratic.trade` $\rightarrow$ `/console`.
  - Positioned subdomain host-level routing at the very top of `middleware.ts` before `isPublicPath` evaluation so root `/` requests on those subdomains redirect to `/mobile` and `/console`.
- **`src/lib/history.ts`**:
  - Added `isBarSeriesFresh(bars, maxStalenessDays = 3, now)` helper: checks if the latest bar timestamp is within 3 calendar days (accounting for weekend gaps).
  - Added `mergeOHLCBars(existing, incoming)` helper: combines historical bars with fresh incoming bars by date `YYYY-MM-DD`, keeping overlap updates and sorting ascending.
  - Added `persistEodBarsToCache(symbol, bars)` helper: auto-upserts fetched bars to SQLite table `imported_price_eod` via `upsertImportedPrices` AND updates local flat file storage (`data/history-5y/${symbol}.json`).
  - Updated `fetchLocalFlatFileHistory` and `fetchDailyOHLC`:
    - Evaluates flat-file freshness first. If flat files exist and are fresh ($\le 3$ days), returns immediately.
    - If flat files exist but are **stale** (> 3 days old), retains the stale bars and continues down the provider cascade (Imported EOD, App A, Massive, Tradier, Tiingo, Marketstack, Robinhood, Yahoo).
    - Merges live provider bars with the stale historical bars so the system maintains a full 5-year series while incorporating fresh recent bars, and auto-persists the merged series to SQLite & disk.
    - If all active providers fail or encounter expired keys and only stale bars exist, logs an explicit `eod_cache_stale` audit warning (`audit("eod_cache_stale", ...)`) before returning the fallback bars.
- **Tests**:
  - `test/subdomain-routing.test.ts`: Added unit tests verifying 307 redirects for mobile and console subdomains and pass-through for existing `/mobile` & `/console` paths.
  - `test/history.test.ts`: Added unit tests for `isBarSeriesFresh` and `mergeOHLCBars`.

## 3. Verification State

- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors (665 warnings pre-existing)
- `npx vitest run test/subdomain-routing.test.ts test/history.test.ts` — 27/27 tests passing
- `npm run build` — Clean production Next.js build

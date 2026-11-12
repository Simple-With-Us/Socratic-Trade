# ST: nightly Congress.Trade fundamentals + analyst push (ST-4537)

## Context & Objective

Congress.Trade watchdog `st_inbound_market_data` reported fundamentals and analyst streams stale since **2026-10-06 08:20Z** while prices/refs continued.  Fundamentals and analyst only rode the after-scan `shareScanRefs` hook (throttled, scan-quote-shaped).  The nightly `runCongressDailyShare` batch never sent those datasets, so CT could go days without a fundamentals/analyst touch even when scans ran.

## Changes Made

- `buildFundamentalsAndAnalystImport()` reads `symbol_field_latest` for the nightly universe and maps rows via existing `marketQuoteToFundamentals` / `marketQuoteToAnalyst`.
- Scheduled nightly batch adds chunked `fundamentals` + `analyst` POSTs (same pattern as insider/short-volume).
- Summary/audit fields: `fundamentalsRows`, `analystRows`, and `sent.fundamentals` / `sent.analyst` tallies.

**Files touched**

- `src/lib/congress-share.ts`
- `test/congress-share.test.ts`
- `docs/congress-trade-share.md`
- `STATUS.md`, `PLAN.md`

## Decisions & Trade-offs

- Universe matches nightly prices (monitored symbols + needs merge), not the full field-store symbol set — keeps POST volume bounded by `maxDailyTickers()`.
- Admin symbol-targeted runs (`symbols: [...]`) also push fundamentals/analyst for that universe (manual backfill).  `fromAppANeeds`-only drains skip them (same as insider).
- Root cause for the Oct 6 cutoff: scan-only path + throttle/empty enrichment on candidates; nightly backfill closes the gap without extra vendor calls.

## Verification State

```bash
npm run lint          # 0 errors, 856 warnings (grandfathered)
npx tsc --noEmit      # ok
npm test -- test/congress-share.test.ts   # 95 passed
npm run build         # ok
```

## PR #4730 review follow-up (2026-10-15)

- Reordered nightly POST queue: **prices before fundamentals/analyst** (shared upstream breaker).
- `FieldStoreCongressShareQuoteSchema` Zod gate; removed `MarketQuote` casts.
- Persist `analystBySource` in `symbol_field_latest` (dropped META skip).

## Next Steps & Blockers

- Merge + deploy ST; confirm CT `fundamentals_eod` / `analyst_consensus` `MAX(received_at)` advances after first post-deploy nightly run.
- Optional CT PR: retire `prices` stream from `st_inbound_market_data` when `PRICE_PROVIDER=peer` (CT-2349).

## Zero-Code Findings

- CT prices push last seen 2026-08-03 aligns with CT pulling prices from ST; separate from fundamentals/analyst stall.

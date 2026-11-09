# 2026-06-17 - finra-freshness-calibration

## Summary

A three-part improvement pass (branch `web-sources`): a new free backend data
source, universal data-freshness tooltips, and a learning-loop addition. Paper mode
unchanged. `tsc` clean, 127 tests, build ok; browser-verified.

### 1. FINRA daily short-volume connector (new free data source)
New `src/lib/web-sources/finra.ts` reads FINRA's free, no-key daily consolidated
short-sale volume file (`CNMSshvol{YYYYMMDD}.txt`) and computes a per-symbol
**short-volume ratio** (ShortVolume ÷ TotalVolume) — a daily short-pressure read
that complements Yahoo's biweekly short-interest. Elevated pressure (>55% of the
day's volume) becomes an evidence bulletin fed to the agent + scan tooltips. Daily
refresh, persisted, retry-backoff, degrades to nothing on failure. Wired into
`refreshDueWebSources`, the scan overlay (`SymbolWebSignal.shortVolumeRatio` +
bulletin), and `getWebSourcesStatus`. **Live-verified: 11,555 symbols scraped**
(GME 62.8% → elevated, AAPL 45.2%, NVDA 37.2%).

### 2. Universal data-freshness tooltips
New `receivedLabel(ts)` (clock time if <24h, else date) + `cellTitle` now appends
it. Every Market Scan cell's hover tooltip now shows **"Received HH:MM"** (the
scan's ISO `generatedAt` — the quote `asOf` is a display string, not a timestamp),
on top of the existing source/methodology info. Also fixed a latent "Quote time:
Invalid Date" in `quoteTitle` by validating `asOf` before formatting. Verified: 255
cells all carry a received-time tooltip; no Invalid Date.

### 3. Confidence calibration feedback (learning)
New `getConfidenceCalibration` buckets closed BUY lots by the agent's entry
`confidenceScore` band (threaded onto `ClosedLot` via `thesisMetaFromFill`) and
reports realized win/return per band. Fed to the prompt as `confidenceCalibration`
with an instruction: since confidence now drives position size, if the high-
confidence band doesn't out-win the low band, the agent is over-confident and should
compress its scores. This closes the loop between conviction and the Kelly sizer.

## Plan evaluation note

This continues working through Codex's research plan. FINRA short-volume was an
explicit deferred item ("market-wide positioning from FINRA short-sale volume").
Still deferred: Cboe put/call (their CSV API is 403 / page is HTML-only — brittle to
scrape), Kenneth French factors, sector as a 4th learning dimension (sector isn't on
fills yet), and async filing/transcript digests.

## Files

- New: `src/lib/web-sources/finra.ts`, `test/web-sources-finra.test.ts`.
- Edited: `src/lib/web-sources/{types,index}.ts`, `src/lib/dashboard-ui.ts`
  (`receivedLabel`, `cellTitle`, `quoteTitle` guard), `app/dashboard-client.tsx`
  (received-time tooltips), `app/dashboard-types.ts` (finra status),
  `src/lib/performance.ts` (`getConfidenceCalibration`, `ClosedLot.confidence`),
  `src/lib/strategy.ts` (calibration in prompt), `test/performance.test.ts`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 127 passed (17 files; +5: FINRA ×4, calibration ×1)
npm run build      # succeeds
```

Live: FINRA 11,555 records in `webSources`; scan cells show "Received 12:36 PM".

# 2026-06-25 — Massive flat-file bulk backfill + broad-universe expansion (Phase 4)

Branch `agent/claude-flatfile-backfill`. Phase 4 of `docs/settings-and-universe-overhaul-plan.md`.

## Summary
Adds a reusable **flat-file bulk history source** (one Massive flat file = a whole day of the market) and
wires it into the App A backfill as an opt-in path, so a **broad universe** (all index members) can be
backfilled efficiently instead of N per-ticker REST calls. Verified end-to-end against the live paid
flat-file bucket.

## Why
Owner provisioned paid Massive flat-file access. The per-ticker backfill is fine for ~500 names but doesn't
scale to "all indexes above the floor" (thousands of tickers → thousands of calls / API-cap pressure / the
timeout that started this thread). Flat files invert the cost: ~one download per business day covers every
ticker. The S3 client (`massive-s3.ts`) already existed but was dormant (prior plan returned 403); the new
creds unlock it (the pasted "S3 secret" had a one-char typo — the correct secret is the Massive API key).

## What changed
- **`src/lib/market-signals/massive-s3.ts`** — new bulk range layer on top of the existing
  `fetchGroupedDailyBars`:
  - `businessDaysBetween(from, to)` — inclusive weekday list (pure; holidays 404 and are skipped at fetch).
  - `pivotDayAggsToSeries(days, tickers?)` — pivot per-day grouped bars → per-ticker ascending `OHLCBar[]` (pure).
  - `fetchGroupedDailyBarsRange(from, to, {tickers, userId, maxFiles, concurrency})` — download the daily
    files across the range (bounded concurrency, `maxFiles` cap keeps the most-recent window), filter to the
    universe at fetch time (bounds memory to universe×days), and pivot. Returns an empty map when flat files
    are ungranted → callers fall back to per-ticker.
- **`src/lib/congress-share.ts`** — `runCongressDailyShare` gains `flatFile?` and `allIndexes?`:
  - `allIndexes` → universe = union of every STATIC index universe's members + monitored (deduped, still
    `maxDailyTickers`-capped). New exported `allIndexUniverseSymbols()`.
  - `flatFile` → build full-history price entries from one `fetchGroupedDailyBarsRange` pass over the universe
    (window `MASSIVE_FLATFILE_BACKFILL_YEARS`, default 5), with per-ticker `fetchDailyOHLC` fallback for any
    symbol the flat files miss. Default (non-flatFile) path unchanged.
- **`app/api/admin/congress-share/route.ts`** — accepts `flatFile` + `allIndexes`; doc comment updated.
- **`.env.example`** — documents `MASSIVE_S3_REGION` + `MASSIVE_FLATFILE_BACKFILL_YEARS` and that the S3
  secret = the Massive API key.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/flatfile-range.test.ts test/congress-share.test.ts` — 39 pass
  (businessDaysBetween weekend/inclusive/reversed/invalid; pivot ordering + ticker filter + uppercasing).
- **Live smoke** (throwaway, removed): `fetchGroupedDailyBarsRange("2026-06-19".."2026-06-24", {AAPL,MSFT})`
  returned real bars (AAPL 2026-06-22 O 297.31 / C 297.01 / V 44.8M), Juneteenth (6/19) correctly skipped,
  `resolveApiKey` resolved the S3 creds (shared-operator-infra tier). Full trio via `scripts/land.sh`.

## How to run a broad flat-file backfill (ops)
From a logged-in browser console at the host (or on-box localhost with the cf-access header):
`POST /api/admin/congress-share {"fullHistory":true,"flatFile":true,"allIndexes":true}`.

## Follow-ups
- This is opt-in; the nightly default backfill is unchanged. Activating `allIndexes` broadly pushes more
  tickers to App A — coordinate cadence with App A.
- Phase 3 (settings overhaul) is the remaining program phase.
- Future: a true data-lake (R2 Parquet + DuckDB) for backtests, per the data plan.

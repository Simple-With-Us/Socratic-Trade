# Free data gaps: deep history, Form 4, Senate eFD

## Context & Objective

Three free-tier holes were still leaving dashboard fields thin.  Massive free aggregates stop near two years, so a five-year daily request could win the cascade with a truncated series, and Stooq is already out because the server blocks it.  `insiderSentiment` stayed partial across a large symbol set because the Form 4 atom pass defaulted to 60 filings and then sliced the watchlist to 20.  `senateTrades` had a Senate eFD scraper, but Congress.Trade-first mode never used it when the primary source failed.

## Changes Made

Deep daily OHLC (`lookbackDays` above 730, including the 1825-day default) skips Massive.  The live order is imported EOD, App A, Yahoo chart `range=max` under `withProviderLimit("yahoo-finance")`, Tradier history, Twelve Data, then Alpaca, Robinhood, ROIC, Tiingo, and Marketstack.  Lookbacks of 730 days or less keep the previous broker-first order, including Massive and Yahoo `range=1y`.  SQLite `history_cache_eod` remains a permanent upsert with no age delete.  On a deep request a fresh local series returns with no network only when its oldest bar is on or before the requested start.

Insider refresh still runs from the existing `web-source-refresh` lane (default 24h TTL).  It downloads the current SEC insider-transactions ZIP and the quarter that covers the prior 90 days, parses open-market `P` and `S` rows, and merges the Form 4 atom feed as a delta on the same accession.  The score is `round(100 * buyValue / (buyValue + sellValue))` over that window, which is `50 + 50 * (net purchases / total value)`.  Unpriced rows fall back to shares, then to transaction counts.  Signals are stored on the dataset.  `WEB_SOURCE_INSIDER_MAX_FILINGS` now defaults to 0, and 0 means the atom feed is uncapped.  The watchlist XML pass runs only when the ZIP returned no filings, and it is no longer sliced to 20.  SEC requests still go through the existing limiter, and the User-Agent fallback is `Socratic Trade research jay@socratic.trade` (an explicit `SEC_EDGAR_USER_AGENT` still wins).

When `CONGRESS_TRADE_AS_CONGRESS_SOURCE` is on, a Congress.Trade error or an empty non-incremental result falls back to `scrapeSenateEfd` (agreement cookie, CSRF, PTR HTML).  A successful empty incremental poll keeps the prior dataset and does not scrape eFD.  Quiver is not called.

- `src/lib/history.ts`
- `src/lib/history-cache.ts`
- `src/lib/web-sources/insider-bulk.ts`
- `src/lib/web-sources/sec.ts`
- `src/lib/web-sources/http.ts`
- `src/lib/web-sources/sec-facts.ts`
- `src/lib/web-sources/congress.ts`
- `src/lib/source-settings-catalog.ts`
- `test/history.test.ts`
- `test/web-sources-sec.test.ts`
- `test/web-sources.test.ts`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-9-web-sources.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

A live source still wins on two or more bars.  Requiring the full lookback before a source wins would drop the existing two-bar fixtures through to Marketstack.  The coverage gate applies only to the SQLite early return on deep requests.

Twelve Data is only on the deep path.  Its key is the per-user `twelvedata` service (`TWELVEDATA_API_KEY` migrates in; it is not read as a live env override).  Calls admit one request against the 8/minute and 800/day quota.

Cached insider signals are reused when `windowDays` matches and are not recomputed against a later `now` until the next refresh.  The TTL is 24h.

The SEC XBRL 8s budget in the enrichment cascade and the scheduler RTH cap of 3 filing bodies are 10-K/10-Q company-facts and RAG ingest.  They are not the Form 4 sentiment path and were left unchanged.

Bulk ZIP parsing keeps only in-window `P`/`S` filings.  A 404 on the ZIP does not wipe the atom path.

Senate HTML uses the browser User-Agent already on `scrapeSenateEfd`, not the SEC research User-Agent.  PTR detail fetches stay paced at 350ms.

## Verification State

Targeted, before the full gate:

```bash
npx vitest run test/history.test.ts test/web-sources-sec.test.ts test/web-sources.test.ts
```

3 files, 63 tests, exit 0.  The Congress.Trade 503 log line in that run is the fallback test throwing so eFD runs.

Full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`) is recorded in a follow-up edit of this note after it runs.  `npm test` is the full suite.  No fast mode.

## Next Steps & Blockers

Open the PR ready for review.  Do not merge from this lane.  Do not deploy.

Fleet Linear (team ST) and Zulip were not claimed from this cloud seat when `board` / `agent-sync` identity was unavailable.  That does not block the code.  The next seat with fleet credentials should open or move the ST issue and link it.

## Zero-Code Findings

Stooq was already removed from the cascade; `parseStooqCsv` remains for imported files.  `history_cache_eod` was already a permanent upsert, so "cache historical bars permanently" did not need a new table or a retention delete.  The insider partials were the catalog default of 60 atom filings plus `.slice(0, 20)` on the watchlist, not the XBRL time budget or the RTH filing-body cap.  Direct Quiver access stays retired.

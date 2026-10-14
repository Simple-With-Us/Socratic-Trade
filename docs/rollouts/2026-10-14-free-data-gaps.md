# Free data gaps: deep history, Form 4, Senate eFD

## Context & Objective

Three free-tier holes were still leaving dashboard fields thin.  Massive free aggregates stop near two years, so a five-year daily request could win the cascade with a truncated series, and Stooq is already out because the server blocks it.  `insiderSentiment` stayed partial across a large symbol set because the Form 4 atom pass defaulted to 60 filings and then sliced the watchlist to 20.  `senateTrades` had a Senate eFD scraper, but Congress.Trade-first mode never used it when the primary source failed.

## Changes Made

Deep daily OHLC (`lookbackDays` above 730, including the 1825-day default) skips Massive.  The live order is imported EOD, App A, Yahoo chart `range=max` under `withProviderLimit("yahoo-finance")`, Tradier history, Twelve Data, then Alpaca, Robinhood, ROIC, Tiingo, and Marketstack.  Lookbacks of 730 days or less keep the previous broker-first order, including Massive and Yahoo `range=1y`.  Both Yahoo ranges use that pacer because they share the chart host.  The abort timer starts after the slot is acquired.  Twelve Data responses pass `TwelveDataTimeSeriesSchema` before bars are built.  SQLite `history_cache_eod` remains a permanent upsert with no age delete.  On a deep request a fresh local series returns with no network when its oldest bar is on or before the requested start, or when a prior `range=max` fetch stored `history:listing-start:<symbol>` and the cached series still starts on or before that date.

Insider refresh still runs from the existing `web-source-refresh` lane (default 24h TTL).  It downloads the current SEC insider-transactions ZIP and the quarter that covers the prior 90 days, parses open-market `P` and `S` rows, and merges the Form 4 atom feed as a delta on the same accession.  The score is `round(100 * buyValue / (buyValue + sellValue))` over that window, which is `50 + 50 * (net purchases / total value)`.  Unpriced rows fall back to shares, then to transaction counts.  Signals are stored on the dataset.  `WEB_SOURCE_INSIDER_MAX_FILINGS` now defaults to 0, and 0 means the atom feed is uncapped.  The watchlist XML pass runs unless the current quarter ZIP downloaded.  A previous-quarter ZIP does not count as coverage, and the pass is not sliced to 20.  When bulk and XML share an accession, dollar, share, and transaction totals keep the larger side.  SEC requests still go through the existing limiter, and the User-Agent fallback is `Socratic Trade research jay@socratic.trade` (an explicit `SEC_EDGAR_USER_AGENT` still wins).

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

Bulk ZIP parsing keeps only in-window `P`/`S` filings, and each submission, owner, and transaction row is checked with a Zod schema before it is aggregated.  The collapsed filing is checked again with the exported strict `BulkInsiderFilingSchema`.  `BulkInsiderFiling` is `z.infer` of that schema.  An undeclared key fails the parse.  A 404 on the ZIP does not wipe the atom path.  The 1825-day default is unchanged from main's hardcoded start.  Callers that want the short cascade pass `lookbackDays` of 730 or less.

Review follow-up for PR #4661 (board `b53cc5f8970c469e8f561767c35fc334`).  A later pass merged `origin/main` at `79df823d` (motion lockfile only).  No source conflicts.

Senate HTML uses the browser User-Agent already on `scrapeSenateEfd`, not the SEC research User-Agent.  PTR detail fetches stay paced at 350ms.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npx vitest run test/congress-share.test.ts test/sec-facts.test.ts test/sec-ingest-worker.test.ts
npm run build
```

`npm run lint` ok (0 errors, 866 warnings on the first pass; a second pass after the mock fixes was 0 errors and 867 warnings, then the new unused fetch argument was referenced).  `npx tsc --noEmit` ok after the test-type fixes.  Targeted history and web-source tests: 63 passed.  After the full suite, the three files the new score and User-Agent import broke were fixed and re-run: 144 passed.

`npm test` (full suite, no fast mode): 29 failed, 9278 passed, 51 skipped, 826 files, about 19 minutes.  The wrapper can exit 0 while vitest prints failures; this run's log ended `EXIT:1`, and the `Tests ... failed` line is authoritative.

Six of those failures were this diff and are fixed:

- `test/congress-share.test.ts` expected the old count score 75.  Unpriced rows with shares now score `12000/14000` = 86.
- `test/sec-facts.test.ts` and `test/sec-ingest-worker.test.ts` mocked `web-sources/http` without `secUserAgent`, which `ingestCompanyFacts` now calls.

The other 23 failures are this cloud shell, not this diff: OpenRouter and native LLM routing tests see a configured key (`chat-llm`, `llm-provider`, `framework-review`, `red-team`, `openrouter-credits`); Pushover and email tests see injected notify credentials; `cpuprofile-summary` cannot load a `.ts` module under Node 22; `server-metrics` does not treat this VM as the local host; Alpha Vantage mid-chunk fast-stop counted 3 fetches instead of 2.  None of those files are in this diff.

`npm run build` ok on the first pass of this branch.  It compiled with the existing warning backlog and collected page data.

Review follow-up (`origin/main` was already merged, no merge commit):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 1 failed, 9310 passed, 51 skipped, 826 files.  The failure is `test/egress-guard.test.ts` resolving `https://discord.com` with real DNS.  This shell cannot resolve that host.  The file is not in this diff.  Targeted history and web-source tests, run in addition to `npm test`: 67 passed.  `npm run build` was not part of that pass.

Schema colocation after merging `origin/main` (`79df823d`):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 1 failed, 9311 passed, 51 skipped, 826 files.  The same discord.com DNS failure remains.  That file is not in this diff.  Targeted history and web-source tests, run in addition to `npm test`: 68 passed.  `npm run build` compiled with warnings in 82s, then the process was killed (exit 137) during Next.js "Running TypeScript".  Standalone `tsc --noEmit` had already passed.  Hosted `verify` runs the real build.

Merged `origin/main` at `82162336` (PR #4663) with no conflicts, then answered the two open Kody threads:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings on the full tree before the test edit; `npx eslint test/web-sources-sec.test.ts` pass after it).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 2 failed, 9318 passed, 51 skipped, 827 files.  `test/egress-guard.test.ts` cannot resolve discord.com.  `test/data-catalog-completeness.test.ts` sees `peRatio` completeness 1 from this workspace's stored coverage report.  Neither file is in this diff.  Hosted `verify` passed on `9b61310b`.  Targeted `npx vitest run test/web-sources-sec.test.ts test/history.test.ts test/web-sources.test.ts test/trading-liveness.test.ts test/batched-halt-cause.test.ts`: 91 passed.  `npm run build` pass.  It compiled with the existing Edge warnings, finished TypeScript, and generated 43/43 static pages.

`parseInsiderBulkTables` only accepts TSV tables, so the negative case injects the strict-schema rejection (an undeclared `extra` key) at the `safeParse` call the parser already makes.  The returned list is empty.  Removing that call would leave the NVDA filing in the result.

## Next Steps & Blockers

Ask Kody to re-review.  Do not merge from this lane.  Do not deploy.  Do not resolve review threads from this lane.  PR Autofix remains red on every review event because `AI-Fleet-Coordinator` `pr-autofix-reusable.yml` at `2e671004` uses `secrets` in a step `if`.  That is not fixed by a caller edit on this branch.

Board row `b53cc5f8970c469e8f561767c35fc334` is claimed in progress by GROK.  Fleet Linear team ST was not moved.  `AGENT_SEAT` is unset on this cloud seat, and the board file used `--by GROK` because that is the seat writing the PR.  Do not mark the row completed until the PR merges.

## Zero-Code Findings

Stooq was already removed from the cascade; `parseStooqCsv` remains for imported files.  `history_cache_eod` was already a permanent upsert, so "cache historical bars permanently" did not need a new table or a retention delete.  The insider partials were the catalog default of 60 atom filings plus `.slice(0, 20)` on the watchlist, not the XBRL time budget or the RTH filing-body cap.  Direct Quiver access stays retired.

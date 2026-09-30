# 2026-09-30 - ST Performance Measurement Upgrades (Lane h4, Board 687a5fb4)

Wed, Sep 30, 2026 at 1:45 AM CT (review round added 4:55 AM CT)

## 1. Context & Objective

Lane G4 of the 2026-09-25 wave (measurement upgrades) never ran to completion.  Its scope was six
gaps in `GET /api/ops/performance` and the numbers under it: round-trip grading, an explicit
"unattributed" model row, the proposal funnel per proposing model, itemised broker-rejection
reasons with timestamps, real unrealized P&L (`pricesUnavailable` was hardcoded `true`), and the
SPY benchmark frozen since 2026-07-24 (perf-17).

A code-archaeology pass first, because other lanes had moved:

- MM's PR #3895 (`991c02a4e`) already landed round-trip grading (`roundTripStats`), the
  `unattributed` model bucket, the per-model funnel (`byModel`), and a first cut of
  `brokerRejectionReasons`.  Those four are NOT re-implemented here; this lane builds on them.
- The AG branch the G4 brief told us to check (`ag/perf-twr-basis`, board row 1b5e3ffe) has no
  remote branch and no PR.  The only related merged PR, #3345, is a different fix (TWR cap by daily
  snapshots).  When this lane was first written perf-17 was uncovered; it has since been fixed on
  `main` by #4009 (see 2.6 and the Review Round), so this lane only keeps two small extras.

What remained, and what this lane does: real unrealized P&L, first/last-seen timestamps on reason
buckets with the old top-10 cap lifted, `placing_failed` reasons (a second, previously invisible
path for broker refusals), a normaliser that actually merges the real nested-JSON refusal strings,
and the stale SPY benchmark (since fixed by #4009).

## 2. Changes Made

### 2.1 Real Unrealized P&L (`src/lib/ops-performance.ts`, `src/lib/performance.ts`, route)

Every account reported `pricesUnavailable: true` and unrealized `0`, so about $100K of paper equity
in open positions read as flat.

- New pure helpers in `performance.ts`: `unrealizedFromOpenLots(openLots, prices)` and
  `openLotSymbols(...books)`.  Unrealized is computed over the `openLots` the account's single
  `calculatePnl({})` call already produced, so there is no second FIFO walk.  A symbol without a
  strictly positive mark is skipped, never fabricated as a `$0` mark.
- Marks come from the STORED latest-price rows by default (`marks=stored`): `resolveOpsMarks` does
  one indexed `getSymbolLatestPrices` read (table `symbol_field_latest`, kept warm by the dashboard
  and every quote refresh; never FMP, owner rule 2026-08-20).  A row older than 10 days is treated
  as unpriced, and each account reports `unrealizedMarkBasis` and `unrealizedMarksOldestAsOf` so the
  age of the figure is visible.
- `marks=live` opts in to ONE Alpaca market-data snapshot batch on top of the stored marks
  (`fetchLiveSnapshotMarks`, `AlpacaSnapshotEnrichmentProvider`).  `marks=off` (or `0`/`false`)
  skips marking.  The first cut of this lane marked through `fetchFreshQuotesCascade`; the review
  round replaced that (see the Review Round), and the trading cascade is no longer called.
- `pricesUnavailable` now means "the book has open positions and none could be priced".  A new
  `unrealizedUnpricedSymbols` lists open symbols that got no mark.
- `resolveShrinkPrior` in `performance.ts` (used by every scorecard aggregation) read
  `getPolicy(userId)`, which seeds an `account_strategy_state` row the first time it touches a
  user's active account that has none.  It now reads `peekPolicy`, so the token-gated GET performs
  no policy write.

### 2.2 Bounds On Marking (endpoint stays cheap)

- Stored mode: one indexed read per account with open lots, at most 200 symbols
  (`OPS_MARK_MAX_SYMBOLS`), the excess reported unpriced.  No network, no policy read, no broker
  gateway, no history fetch.
- Live mode adds at most 100 symbols (`OPS_QUOTE_MAX_SYMBOLS`) in one snapshot batch per account,
  an 8 second deadline (`OPS_QUOTE_FETCH_TIMEOUT_MS`), and one 20 second budget of live-waiting time
  for the whole request (`OPS_QUOTE_TOTAL_BUDGET_MS`).  The budget counts time spent waiting on the
  provider, not wall clock since the build began, so a large ledger on an early account cannot
  starve later ones.  A timeout keeps the stored marks already gathered (the old cascade path
  discarded every price on timeout).
- A per-request memo, so a ticker held in several accounts is marked once, and a symbol that
  already failed in this build is not retried by the next account.
- No lookup at all for an account with no open lots.  The existing 60 second single-flight cache
  (keyed per mode) and the per-account `yieldEventLoop()` are unchanged.

### 2.3 Reason Buckets With Timestamps And A Sane Cap

`topBlockReasons`, `brokerRejectionReasons`, and the new `placingFailureReasons` are now
`{ reason, count, firstSeenAt, lastSeenAt }`.  The output cap moved from 10 and 20 to 50
(`MAX_REASON_BUCKETS`); the row scans keep their own 1000-row bounds, so this changes payload size,
not query cost.  When a scan hit its cap (`*RowsCapped`) the timestamps describe the newest scanned
rows only.

### 2.4 Broker Refusal Normaliser

`normalizeBrokerRejectionReason` replaces the HTTP-prefix-only canonicaliser.  Robinhood wraps its
refusal two levels deep (`place_equity_order response had no order id: {"text":"API error 400:
{...non_field_errors...}"}`) and embeds a dynamic amount, so the same rule read as many causes.  It
unwraps up to three levels of JSON, salvages the sentence from a message truncated mid-JSON (which
is how the account-questionnaire error is stored), strips `HTTP <code>:` and `API error <code>:`,
and collapses amounts (`$1` and `$5` read `$N`).  It never throws, and never merges different
sentences.

### 2.5 `placing_failed` Reasons

The 22 Robinhood `placing_failed` rows carry the broker's refusal in `error_message` and never
wrote an `order_rejected_by_broker` audit row, so the existing scan could not see them.  A new
bounded scan over `(user_id, account_number, created_at)` (the same index as the block-reason scan)
itemises them; a row with no message reads `(no error message recorded)`.

### 2.6 perf-17: SPY Benchmark Frozen At 2026-07-24 (`src/lib/history.ts`, `src/lib/benchmark.ts`)

Root cause: in `fetchDailyOHLC` the imported-EOD tier accepted any series with at least two bars
and returned it with no freshness check, unlike the SQLite EOD-cache tier above it.  Once the
imported feed stopped refreshing (last bar 2026-07-24) no live provider was ever tried, and the
benchmark read `source: imported-eod` for two months.

`main` gained the same fix while this PR was open: #4009 (e89515323, 04:01 CT Sep 30) gates the
imported tier on freshness and adds a stale-import fallback.  This branch was merged with
`origin/main`, conflicts in `history.ts` and `securities-import.test.ts` resolved to ONE freshness
gate and ONE stale-fallback branch (main's shape).  Two extras of this lane are kept on top:

- A stale import is also a merge base for a live fetch: a live provider's bars are merged into the
  stale local cache and the stale import (import bars keep their `imported-eod` tag), so a live
  source that returns a shorter window does not truncate history.
- When every live tier fails and the fallback is import-only, the series is stamped
  `imported-eod-stale` (a merged or local fallback keeps `history-cache-eod-stale`), and
  `benchmark.ts` treats both stamps as a stale-cache fallback (`fellBackToStaleCache`).

### 2.7 Files Touched

- `app/api/ops/performance/route.ts`
- `src/lib/ops-performance.ts`
- `src/lib/performance.ts`
- `src/lib/history.ts`
- `src/lib/benchmark.ts`
- `test/ops-performance-unrealized.test.ts` (new, 19 cases: stored, live, off, route, no policy write)
- `test/ops-performance-measurement.test.ts`
- `test/ops-performance.test.ts`
- `test/realized-pnl-ledger.test.ts`
- `test/securities-import.test.ts` (main's #4009 cases kept, plus the merge-with-live and import-only stamp cases)
- `test/benchmark-feed-visibility.test.ts`
- `docs/runbooks/ops-performance-endpoint.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- Build on #3895 instead of re-implementing it.  The brief listed round trips, the unattributed
  row, and the per-model funnel as G4 scope; all three are already on `main`, so re-doing them
  would only create a merge conflict.
- Unrealized P&L is best effort by design and DEFAULTS to stored marks.  A production process whose
  event loop is known to stall must not run the trading quote cascade for a diagnostic GET, so the
  default is a single indexed read and `marks=live` is an explicit opt-in to one bounded Alpaca
  snapshot batch.  The trade-off: a stored mark can be hours or a weekend old (visible through
  `unrealizedMarksOldestAsOf`), and it can only be as fresh as the last dashboard or quote refresh.
  `marks=off` is the escape hatch for a probe that wants none of it.
- Live mode skips broker gateways on purpose.  Other-broker `getEquityQuotes` (Alpaca, Tradier) runs
  an unbounded per-symbol `fetchDailyOHLC` fan-out that finishes with synchronous cache writes and
  ignores the abort, which is unacceptable inside a diagnostic.  Alpaca snapshots cover the equity
  book without it.
- Both live and paper unrealized figures are marked with the same price map, since both books
  belong to one account and one ticker has one current price.
- The normaliser is deliberately not a full canonicaliser: over-merging distinct refusals is worse
  than under-merging.  It only unwraps JSON, strips transport prefixes, and collapses numbers.
- The perf-17 fix (now #4009's gate) lives in the shared history cascade and DOES change trading-input
  history fan-out: `fetchDailyOHLC` feeds strategy, strategy-risk, the outcome engine, and backtests.
  With the imported-EOD tier on and a stale imported series, each symbol now walks the live
  providers once instead of returning the import instantly, and if all of them fail the stale
  fallback is cached for 5 minutes and re-audited.  The tier is default OFF
  (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED`), so it is inert wherever the tier is off.  An earlier
  draft of this note said no trading behaviour changed; that was wrong for the history cascade.
- Not done: a per-provider failure record in the cascade (the discarded provider errors that
  `benchmark.ts` documents).  That is a separate observability change.

## 4. Verification State

Run in `~/apps/claude-st-w3-h4` with Node 24 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`):

```bash
npx tsc --noEmit
npx vitest run test/ops-performance.test.ts test/ops-performance-measurement.test.ts \
  test/ops-performance-unrealized.test.ts test/benchmark-feed-visibility.test.ts \
  test/realized-pnl-ledger.test.ts test/securities-import.test.ts
npx eslint src/lib/ops-performance.ts src/lib/performance.ts src/lib/history.ts \
  src/lib/benchmark.ts app/api/ops/performance/route.ts
```

Results on the review-round commit: the six targeted test files passed (6 files, 89 tests) after
the merge with `origin/main`; `test/ops-performance-unrealized.test.ts` was also run against the
pre-fix `ops-performance.ts`, `performance.ts`, and route with the new tests in place and failed
16 of 19 cases (the other 3 assert an unpriced outcome the old code also produced), which is the
fail-first evidence.  The host sat at load average about 150 for the whole first session, so
`npm run build` and the full suite were not run locally; the required CI check `verify` is the
full-suite and build gate of record.  The measurement and
unrealized test files now import `ops-performance` once in `beforeAll` (300 second hook timeout),
because the cold import alone exceeded the 60 second per-test timeout under that load.

Fix-up pass on merge commit `63db802b9` (2026-09-30, load average 500 to 900): `npx eslint` on the
touched source and test files exited 0 (0 errors; 6 warnings, all pre-existing unused-import or `any`
warnings in lines this lane did not add).  A local `npx tsc --noEmit` and the six-file vitest run
were started and stopped after tsc had run for 39 minutes without finishing on the overloaded host,
so neither result is claimed here.  The gate of record for that head is the CI run on PR #4006:
`verify` (tsc, full vitest suite, `next build`), `verify-hosted`, and `verify-ios / xcodebuild
(unsigned)` all completed SUCCESS on `63db802b9`, with merge state CLEAN.

## 5. Next Steps & Blockers

- After merge and deploy, `bash scripts/fetch-prod-ops-performance.sh` and confirm the Alpaca Paper
  account reports a non-zero `paperUnrealizedPnl`, `pricesUnavailable: false`, an
  `unrealizedMarksOldestAsOf` within a day or so, and that `placingFailureReasons` itemises the
  Robinhood `$1` refusals.  If the oldest as-of is stale, add `marks=live` to that one call.
- Confirm the SPY benchmark `feed.source` is no longer `imported-eod` with a 2026-07-24 last bar
  (on the dashboard benchmark diagnostic).  If the imported tier is enabled in production and every
  live provider also fails, it will read `imported-eod-stale`, which is the honest state.
- The Robinhood account-questionnaire refusals are an owner action (not fixable in code); the new
  bucket makes their first and last occurrence visible.

## 6. Zero-Code Findings

- `ag/perf-twr-basis` does not exist on the remote and has no PR; PR #3345 (merged 2026-09-16) is a
  TWR-cap fix, not perf-11 or perf-17.  An earlier runbook note claiming AG owned perf-11 was stale
  and is corrected in `docs/runbooks/ops-performance-endpoint.md`.
- Round-trip grading, the unattributed row, the per-model funnel, and a first cut of
  broker-rejection reasons were already on `main` via #3895.

## 7. Review Round (2026-09-30)

Five findings from the review stage, each verified against the code before acting.

1. **P1, default marks path runs the trading quote cascade and discards all prices on timeout.**
   Real.  `fetchOpsMarks` called `fetchFreshQuotesCascade`, whose accept gate needs a fresh AND
   field-complete quote (bid, ask, prevClose, open, high, low; verified in `isCascadeFieldComplete`
   and `acceptIfComplete`), so after hours the residual symbols walked Finnhub (1.2s per symbol on the
   shared pacer), Tiingo (shared hourly budget), unpaced Yahoo singles, and ROIC.  On the 8s
   deadline the `catch` dropped every price gathered.  Fixed: the default is now
   `getSymbolLatestPrices` (one indexed read of `symbol_field_latest`, with `asOf` and a 10 day
   cutoff), `marks=live` is opt-in and limited to one Alpaca snapshot batch, and a timeout keeps the
   stored marks.  The cascade is never called (asserted in the tests).
2. **P2, read-only route can write policy rows via `getPolicy`.**  Real, and wider than reported.
   The cascade path is gone, but the test that pinned it also exposed a second, pre-existing writer
   on the same route: `resolveShrinkPrior` in `performance.ts` calls `getPolicy(userId)` from every
   scorecard aggregation, seeding `account_strategy_state` for the user's active account.  It now
   uses `peekPolicy`.  Test: an active account with fills and no state row still has none after
   `stored`, `live`, and `off` builds.
3. **P2, other-broker quote calls ignore the abort and fan out heavy history fetches.**  Real for
   the cascade's Level 1b (verified: Alpaca and Tradier `getEquityQuotes` run
   `fillMissingQuotesWithClose`, an unbounded `Promise.all` of `fetchDailyOHLC` per unpriced symbol
   with synchronous cache writes).
   Resolved by removing the cascade from the diagnostic entirely; live mode uses only the Alpaca
   snapshot provider, which has its own 8s per-chunk abort and no history fan-out.
4. **P2, perf-17 changes trading-input history fan-out while the PR says no trading behaviour
   changed.**  The documentation half is correct and is fixed: STATUS, this note, the runbook, and
   the PR body now say the freshness gate changes `fetchDailyOHLC` for every symbol when the
   imported tier is on.  The code half (scope the demotion to the benchmark symbols, or keep a long
   TTL on the stale fallback) is DECLINED.  Since this finding was written, #4009 landed the same
   freshness gate on `main` for every symbol, deliberately, to stop a stale dense import from
   beating Tradier, Massive, ROIC, Tiingo, and Yahoo for Congress.Trade's peer feed as well as the
   benchmark; scoping it back to two symbols here would contradict `main`.  The 5 minute fallback
   TTL and per-symbol audit row are also `main`'s pre-existing behaviour for a stale local cache
   (only extended to imports by #4009) and only occur when every live provider fails, so changing
   them belongs in a separate change with its own evidence.
5. **P1, PR conflicts with `main`; perf-17 already fixed by #4009.**  Real.  Merged `origin/main`
   (commit `fc01245b7`), resolved `history.ts` and `securities-import.test.ts` to one freshness
   gate and one stale-fallback branch, kept only the two extras named in 2.6, kept both test sets
   (dropping this lane's duplicate "fresh series still short-circuits" case, which #4009's covers
   more rigorously), and credited #4009 in the PR body, STATUS, the runbook, and this note.

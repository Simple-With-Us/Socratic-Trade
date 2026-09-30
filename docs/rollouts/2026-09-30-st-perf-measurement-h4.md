# 2026-09-30 - ST Performance Measurement Upgrades (Lane h4, Board 687a5fb4)

Wed, Sep 30, 2026 at 1:45 AM CT

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
  snapshots).  So perf-17 was not covered by anyone and is fixed here.

What remained, and what this lane does: real unrealized P&L, first/last-seen timestamps on reason
buckets with the old top-10 cap lifted, `placing_failed` reasons (a second, previously invisible
path for broker refusals), a normaliser that actually merges the real nested-JSON refusal strings,
and the stale SPY benchmark.

## 2. Changes Made

### 2.1 Real Unrealized P&L (`src/lib/ops-performance.ts`, `src/lib/performance.ts`, route)

Every account reported `pricesUnavailable: true` and unrealized `0`, so about $100K of paper equity
in open positions read as flat.

- New pure helpers in `performance.ts`: `unrealizedFromOpenLots(openLots, prices)` and
  `openLotSymbols(...books)`.  Unrealized is computed over the `openLots` the account's single
  `calculatePnl({})` call already produced, so there is no second FIFO walk.  A symbol without a
  strictly positive mark is skipped, never fabricated as a `$0` mark.
- New `fetchOpsMarks` quotes an account's open symbols through `fetchFreshQuotesCascade` with
  `skipActiveBroker: true`, the same fallback the dashboard uses.  It never calls FMP (owner rule
  2026-08-20; `quotes-cascade.ts` has no FMP tier).
- `pricesUnavailable` now means "the book has open positions and none could be priced".  A new
  `unrealizedUnpricedSymbols` lists open symbols that got no mark.
- Route: `marks=0` (or `false`/`off`) skips quoting; the cache key now includes it.

### 2.2 Bounds On The Quote Fetch (endpoint stays cheap)

- At most 100 symbols per account (`OPS_QUOTE_MAX_SYMBOLS`), the excess reported unpriced.
- 8 seconds per account (`OPS_QUOTE_FETCH_TIMEOUT_MS`) with a real `AbortController` plus a
  `withDeadline` guard, so a tier that ignores the signal still cannot hold the request.
- One 20 second budget of quote-waiting time for the whole request (`OPS_QUOTE_TOTAL_BUDGET_MS`),
  so an unfiltered request cannot cost accounts times the per-account ceiling.  It counts time spent
  waiting on quotes, not wall clock since the build began, so a large ledger on an early account
  cannot starve the marks of later ones.
- A per-request memo, so a ticker held in several accounts is quoted once.
- No quote call at all for an account with no open lots.  The existing 60 second single-flight
  cache and the per-account `yieldEventLoop()` are unchanged.

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

- The imported series is evaluated for freshness up front (after the fresh-local-cache
  short-circuit, so a cache hit adds no work).  A fresh one still short-circuits exactly as before.
  A stale one is stamped `imported-eod`, retained as a merge base and final fallback, and the
  cascade reaches the live tiers.
- A live fetch merges into whichever stale candidate has the newer last bar (imported or SQLite
  cache).
- If every live tier also fails, the frozen imported series is re-tagged `imported-eod-stale`
  (mirroring `history-cache-eod-stale`), and `benchmark.ts` treats both stamps as a stale-cache
  fallback (`fellBackToStaleCache`).

### 2.7 Files Touched

- `app/api/ops/performance/route.ts`
- `src/lib/ops-performance.ts`
- `src/lib/performance.ts`
- `src/lib/history.ts`
- `src/lib/benchmark.ts`
- `test/ops-performance-unrealized.test.ts` (new, 11 cases)
- `test/ops-performance-measurement.test.ts`
- `test/ops-performance.test.ts`
- `test/realized-pnl-ledger.test.ts`
- `test/securities-import.test.ts`
- `test/benchmark-feed-visibility.test.ts`
- `docs/runbooks/ops-performance-endpoint.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- Build on #3895 instead of re-implementing it.  The brief listed round trips, the unattributed
  row, and the per-model funnel as G4 scope; all three are already on `main`, so re-doing them
  would only create a merge conflict.
- Unrealized P&L is best effort by design.  A slow feed must never stall a production process
  whose event loop is known to stall, so a timeout degrades to "unpriced" (listed, never `$0`)
  rather than failing the request.  `marks=0` is the escape hatch for a probe that wants none of it.
- `skipActiveBroker: true` avoids a second call to the account's own broker but does not make the
  fetch broker-free; the cascade can still reach the user's other connected brokers'
  market-data-only endpoints.  That is the same behaviour as the dashboard fallback and is
  documented rather than hidden.
- Both live and paper unrealized figures are marked with the same price map, since both books
  belong to one account and one ticker has one current price.
- The normaliser is deliberately not a full canonicaliser: over-merging distinct refusals is worse
  than under-merging.  It only unwraps JSON, strips transport prefixes, and collapses numbers.
- The perf-17 fix lives in the shared history cascade, so it also benefits every other consumer of
  `fetchDailyOHLC` with the imported-EOD tier enabled.  That tier is default OFF
  (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED`), so the change is inert wherever the tier is off.
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

Results on the final commit: `tsc --noEmit` exited 0 with no output; the six targeted test files
passed (6 files, 80 tests); eslint reported 0 errors and 8 warnings, all pre-existing
(`no-unused-vars` and `no-explicit-any` backlog, plus two unused `eslint-disable` directives in
`test/ops-performance.test.ts`).  The host sat at load average 300 for the whole session, so
`npm run build` and the full suite were not run locally; the required CI check `verify` is the
full-suite and build gate of record.

## 5. Next Steps & Blockers

- After merge and deploy, `bash scripts/fetch-prod-ops-performance.sh` and confirm the Alpaca Paper
  account reports a non-zero `paperUnrealizedPnl`, `pricesUnavailable: false`, and that
  `placingFailureReasons` itemises the Robinhood `$1` refusals.
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

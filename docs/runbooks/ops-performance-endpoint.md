# Runbook — `GET /api/ops/performance` (remote realized-performance diagnostics)

## Why this exists

Trading performance could not be measured remotely.  `/api/connected-accounts/[id]/performance`
and `/console/results` are session-gated (no OAuth path for a remote agent, curl, or an uptime
monitor), and `/api/ops/snapshot` (the existing token-gated ops endpoint — see
`docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`) carries strategy-run and audit state but
no P&L.  This endpoint fills that gap.

## What it returns

Token-gated (same gate as `/api/ops/snapshot`), read-only, GET only.  For every connected account
the ops snapshot covers (or one, via `?account=`):

- `label`, `broker`, `environment`, `systemState`, `accountNumber`
- `liveRealizedPnl` / `paperRealizedPnl` — from `getPerformanceSummary`; they never touch a live
  quote.
- `liveUnrealizedPnl` / `paperUnrealizedPnl` — mark-to-market over the `openLots` the account's one
  `calculatePnl` call already produced (`unrealizedFromOpenLots`, pure arithmetic, no second FIFO
  walk).  The open symbols are marked from the STORED latest-price rows (`symbol_field_latest`, via
  `getSymbolLatestPrices`: one indexed read, no network, no policy read; the dashboard and every
  quote refresh keep it warm; never FMP, per the owner rule).  A stored price older than 10 days is
  treated as unpriced rather than marking a position off a stale print.  `marks=live` adds ONE
  bounded Alpaca market-data snapshot batch on top (see Query cost).  The trading quote cascade is
  deliberately NOT used here: it walks Finnhub, Tiingo, Yahoo, and ROIC after hours, reads policy
  through `getPolicy`, and reaches broker gateways whose history fan-out ignores an abort.  A
  missing mark leaves the symbol unpriced instead of failing the request or marking it at `$0`.
- `pricesUnavailable` — `true` only when the book HAS open positions and NONE could be priced (or
  `marks=off` was passed).  An account with nothing open reports `false`: nothing to price is not a
  pricing failure.  `unrealizedUnpricedSymbols` lists the open symbols that got no mark, so a
  partly priced account says exactly which positions the unrealized figure leaves out.
  `unrealizedMarkBasis` says how marks were sourced (`stored`, `live`, or `off`) and
  `unrealizedMarksOldestAsOf` is the ISO time of the oldest mark used, so the age of the figure is
  visible (a stored mark can be a day or a long weekend old).
- `tradeStats` — win rate, avg win/loss (USD), profit factor, expectancy (USD/trade), trade
  count, graded per FIFO exit lot.  Computed over the account's own book (`environment`'s closed
  lots from `calculatePnl`), windowed to `days` by `exitAt`.  A scaled-out position's several trims
  each count as a separate trade here.
- `roundTripStats` — the same shape, graded on completed ROUND TRIPS (one result per opening lot
  once its whole entry quantity has closed) plus `incompleteRoundTrips` and `lotsGraded`.  This is
  the figure to decide on; `tradeStats` is kept beside it because the gap between the two is the
  point.
- `thesisScorecard` — `getThesisScorecard` for the account's own book, lifetime (not windowed —
  matches how the app's own scorecards work elsewhere).
- `redTeamEfficacy` — `getRedTeamEfficacy`, lifetime, capped at 500 scanned veto-audit rows per
  account (the app's own default of 5000 is sized for a single-account request; this endpoint can
  iterate every account for every user).
- `modelAttribution` — closed lots grouped by `proposal.proposedByModel` (win rate + total P&L
  per model), lifetime.  Lots with no model stamped are grouped under `"unattributed"` instead of
  being dropped.
- `proposalFunnel` —
  - `counts` — `trade_proposals.status` counts in the window, and `byModel` — the same split per
    proposing model (`"unattributed"` when no model was stamped).
  - `topBlockReasons` — the first block reason per blocked proposal (`decision.reasons[0]`,
    truncated to 160 characters; reasons that embed a dynamic amount or symbol will not merge).
  - `holdReasons` — the structured `holdReason` of proposals left in "Awaiting approval".
  - `brokerRejectionReasons` — `order_rejected_by_broker` audit rows, normalised to a short key by
    `normalizeBrokerRejectionReason`: it unwraps up to three levels of nested JSON (Robinhood
    wraps its refusal as `place_equity_order response had no order id: {"text":"API error 400:
    {...non_field_errors...}"}`), salvages the sentence from a message truncated mid-JSON, strips a
    leading `HTTP <code>:` or `API error <code>:`, and collapses amounts (`$1` and `$5` both read
    `$N`) so one rule refused at different sizes counts once.
  - `placingFailureReasons` — `placing_failed` proposals itemised by their recorded
    `error_message` through the same normaliser; a row with no message reads
    `(no error message recorded)`.  These never wrote an audit row, so the rejection scan above
    cannot see them.
  - Every reason bucket (`topBlockReasons`, `brokerRejectionReasons`, `placingFailureReasons`) is
    `{ reason, count, firstSeenAt, lastSeenAt }`: the earliest and latest row `created_at` among
    the scanned rows, so a cause that stopped weeks ago reads differently from one still firing.
    Output is capped at 50 buckets (`MAX_REASON_BUCKETS`, raised from 10 and 20 for ops use).  Each
    section has a `*RowsCapped` flag; when it is `true` the timestamps describe the newest scanned
    rows only.
- `equityCurve` — `date`/`equity`/`cash`, one point per calendar day (reuses
  `getPerformanceSummary`'s `live/paperEquityCurve`, itself sourced from
  `listDailyPortfolioSnapshots` — no new query), windowed to `days`.

## Query params

| Param | Default | Notes |
| --- | --- | --- |
| `account` | (all) | One `connectedAccountId`, across every user — mirrors `/api/ops/snapshot`'s all-users iteration. |
| `days` | 90 | Clamped 1-3650.  Windows `tradeStats`, `roundTripStats`, `proposalFunnel`, and `equityCurve`.  `thesisScorecard`/`redTeamEfficacy`/`modelAttribution` are always lifetime. |
| `marks` | `stored` | `stored` marks open positions from the stored latest-price rows (no network).  `live` adds one bounded Alpaca snapshot batch on top and keeps the stored marks if it times out.  `0` / `false` / `off` skips marking and reports open positions unpriced.  Cached per mode. |

## Query cost / caching

This runs inside the SAME production web process whose event loop is already known to stall
under load.  Every query this endpoint adds is bounded:

- The proposal-status GROUP BY and the block-reason scan are both scoped to
  `(user_id, account_number, created_at)` — covered by the existing
  `idx_trade_proposals_user_account_created` index (no new index added).
- Block-reason, broker-rejection, and placing-failure rows are each capped at 1000 per account
  (`MAX_BLOCK_REASON_ROWS`, `MAX_BROKER_REJECTION_ROWS`, `MAX_PLACING_FAILURE_ROWS` in
  `src/lib/ops-performance.ts`); the matching `*RowsCapped` flag says so when a bound was hit.
  Raising the output cap on distinct reasons to 50 changes payload size only, not query cost.
- Unrealized-P&L marking is one indexed read of `symbol_field_latest` per account with open lots
  (at most 200 symbols, `OPS_MARK_MAX_SYMBOLS`; the excess is reported unpriced), memoised so a
  ticker held in several accounts is read once.  `marks=live` adds at most one Alpaca snapshot
  batch per account (100 symbols, `OPS_QUOTE_MAX_SYMBOLS`) with an 8 second deadline
  (`OPS_QUOTE_FETCH_TIMEOUT_MS`) and one 20 second budget across the request
  (`OPS_QUOTE_TOTAL_BUDGET_MS`; ledger time does not consume it).  A timeout keeps the stored marks
  already gathered; it does not discard them.  Neither mode reads policy, calls a broker gateway, or
  fans out history fetches, and neither can throw into the request.
- Red Team veto-audit scan is capped at 500 rows per account (`OPS_RED_TEAM_AUDIT_LIMIT`).
- `liveFills`/`paperFills` are fetched ONCE per account and `calculatePnl` (the FIFO lot match)
  runs ONCE per source — the results are threaded through as `PrefetchedFills`/`PrefetchedPnl` so
  `getPerformanceSummary` and `getThesisScorecard` never repeat that O(fills) work for the same
  account.  The fill fetch itself is unbounded (FIFO replay needs the complete ledger — existing,
  documented constraint in `db-fills.ts`'s `listFillEvents` doc comment, not new here) — **`days`
  does NOT shrink this fetch or the FIFO walk**, only the in-memory windowing of `tradeStats`/
  `proposalFunnel`/`equityCurve` afterward, so a single account's cost is driven by that
  account's total ledger size regardless of the requested window.
- **Unfiltered requests (no `account` param — the endpoint's own documented default; see Usage
  below) repeat that per-account cost once per connected account across every user, in one
  request.**  `buildOpsPerformanceSnapshot` is `async` and calls `yieldEventLoop()`
  (`src/lib/slow-sync-guard.ts` — this codebase's established fix for the event-loop-stall
  incident class linked above, already used by the SEC ingest worker and the RAG FTS mirror)
  once per account processed, so this cannot hold the event loop in one unbroken synchronous
  stretch no matter how many accounts or how large their ledgers — it does not reduce the total
  work, only keeps `/api/health` and other requests servable while it runs.  Covered by
  `test/ops-performance.test.ts`'s "unfiltered, multi-account path" test (4 synthetic accounts x
  500 fills, asserts `yieldEventLoop` is called at least once per account).
- The whole snapshot is cached in-process for 60s, single-flight per `(account, days, marks)` key
  (`src/lib/ops-performance.ts`), so a burst of identical probe requests (an uptime monitor, a
  retried curl) does not multiply the DB work.
- Measured against a synthetic DB in two `test/ops-performance.test.ts` tests: (1) 300 closed
  round trips / 500 proposals / 200 portfolio snapshots on ONE account, filtered by `account`;
  (2) 4 accounts x 250 closed round trips (500 fills each), UNFILTERED — the endpoint's own
  documented default and the more expensive path in practice.  See those tests' console output /
  this rollout's Verification section for the measured durations on the seed hardware.  Both ran
  on a Mac under heavy fleet-wide contention at various points, so a measured duration is not a
  normal-load baseline; each test's own bound is generous specifically to stay a smoke check
  under those conditions rather than a strict benchmark.

## Usage

```bash
export OPS_DIAGNOSTIC_TOKEN=...   # same token /api/ops/snapshot uses
bash scripts/fetch-prod-ops-performance.sh
# or: npm run ops:performance

# narrow to one account, 30-day window:
OPS_PERFORMANCE_ACCOUNT=<connectedAccountId> OPS_PERFORMANCE_DAYS=30 npm run ops:performance
```

Direct curl:

```bash
curl -sS -H "x-ops-token: $OPS_DIAGNOSTIC_TOKEN" \
  "https://socratictrade.com/api/ops/performance?days=30" | jq .
```

## Resolved items

- `perf-11` (per-lot win rate versus round-trip basis) is covered by `roundTripStats`, which grades
  completed round trips beside the per-lot `tradeStats`.  It landed in PR #3895.
- `perf-17` (SPY benchmark frozen at 2026-07-24 with `source: imported-eod`): the cause was in the
  shared `fetchDailyOHLC` cascade (`src/lib/history.ts`), not in this endpoint.  The imported-EOD tier
  accepted any series with at least two bars and short-circuited the whole cascade with no
  freshness check.  The fix on `main` is #4009 (a dense import must reach the latest completed
  session before it may win; a stale one is the all-sources-failed fallback).  It applies to every
  symbol, so a stale imported series now walks the live providers, and when every one fails the
  fallback is cached for 5 minutes.  This lane keeps two small extras on top of #4009: a stale
  import is also a merge base for a live fetch, and an import-only fallback is stamped
  `imported-eod-stale`, which `src/lib/benchmark.ts` recognises as a stale-cache fallback.  AG's
  `ag/perf-twr-basis` branch no longer exists and #3345 (TWR cap by daily snapshots) is a
  different fix.
- Unrealized P&L (`pricesUnavailable` was hardcoded `true`) now uses real stored marks, described above.

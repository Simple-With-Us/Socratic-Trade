# 2026-08-08 — Data integrity: inferred-flow sanity bound, SPY-unavailable state, lot-ledger reconciliation (#2557, #2548)

Branch `monet/review-fixes-b` (review-fix wave B — "data integrity"). Display + aggregation only:
no order placement, fill recording, or wash-sale *enforcement* paths were touched.

## 1. Context & Objective

Two P1s from the 2026-08-06 full-product review survived PR #2536:

- **#2557** — a phantom inferred "withdrawal $36,501.38" on a sub-period whose equity moved only
  −$837 inflated the Results TWR to +56%; separately, the SPY benchmark silently printed 0.00%
  for every sub-period when the SPY series was dead/stale, so "vs SPY" re-printed the account number.
- **#2548** — the FIFO open-lot ledger contradicted the live broker book (T: lots +91.119 long vs
  position −1.881 short; AXP: orphan lot with no position), and wash-sale / early-exit tax figures
  were confidently computed from those wrong lots.

Objective: the math stops *trusting* unverifiable inputs while the owner still *sees* everything
(no silent dropping, no fake numbers, no paternalism — flags and footnotes, not blocks).

## 2. Changes Made

### #2557a — inferred-flow sanity bound
- `src/lib/cash-flows.ts`: new pure `isInferredFlowUnverified(flow, startEquity, endEquity)` +
  exported constants `FLOW_SANITY_EQUITY_DELTA_MULT = 5`, `FLOW_SANITY_PCT_OF_EQUITY = 2`.
  A flow is unverified when `|flow| > max(5×|Δequity|, 2% of start equity)` — a real transfer moves
  equity by roughly its own size; the 2% floor keeps genuine small transfers verified on flat days.
- `src/lib/benchmark.ts` (`normalizeAgainstBenchmark`): an unverified flow is excluded from TWR
  neutralization (the sub-period uses raw equity growth) and from `netExternalFlows`/
  `cashFlowAdjusted`, but stays on the sub-period row (`externalFlow` + new `flowUnverified: true`)
  and is listed in new `BenchmarkComparison.unverifiedFlows`.
- `app/console/lib/derive.ts` (`deriveDayPnl`): same bound applied to the day-P&L flow adjustment —
  a phantom flow falls back to the raw equity delta instead of fabricating day P&L.
- `src/lib/dashboard.ts`: one advisory audit `benchmark_flow_unverified` (rate-limited, see below).
- `app/console/results/page.tsx`: capital-regimes Transfer cell shows a warn chip
  **"inferred — unverified"** with an explanatory title; the card footer states how many inferred
  transfers failed the sanity check and that they are excluded from the math.

### #2557b — SPY benchmark unavailable (no fake 0.00%)
- `src/lib/benchmark.ts`: new `computeSpyBenchmarkDetailed(...)` returning
  `{ comparison, unavailable? }` with reasons `insufficient-history | fetch-failed | no-bars |
  stale-series | insufficient-overlap`; `computeSpyBenchmark` is now a thin back-compat wrapper.
  New pure `assessBenchmarkSeries(...)` (exported, unit-tested) declares the series **stale** when
  its last close predates the account window end by more than `BENCHMARK_STALE_GRACE_DAYS = 5`
  calendar days — the exact live failure shape (the history cascade's stale-local-bars fallback
  froze SPY, printing 0.00% per sub-period). Detail strings carry the last close date + bar
  provenance (`OHLCBar.source`) when present — the cheap "WHY".
- `src/lib/types.ts`: new `BenchmarkUnavailability`; `PerformanceSummary.benchmarkUnavailable`.
- `src/lib/dashboard.ts`: uses the detailed variant; feed failures set
  `performance.benchmarkUnavailable` + one advisory audit `benchmark_unavailable`; the young-account
  insufficient-history case keeps the existing quiet "Not computable yet" copy (no audit).
- `app/console/results/page.tsx`: first-class **"benchmark unavailable"** card state (warn chip,
  reason copy, detail line) — never a 0.00% comparison against a dead feed.

### #2548 — lot-ledger vs live positions reconciliation
- `src/lib/tax.ts`: new pure `reconcileOpenLotsAgainstPositions(openLots, livePositions)` — flags a
  symbol when the lot-implied signed net quantity vs the live position has a sign flip, an orphan
  lot (position flat/absent), or a magnitude gap > max(0.01 sh, 5%). `getTaxSummary` gains an
  optional trailing `livePositions` param (normalized symbol → signed qty; shorts negative).
  For mismatched symbols: open-lot rows keep rendering with `ledgerMismatch: true` but their
  `unrealizedGain`/`earlyExitTaxPremium` are suppressed (rendered "—"); the symbol is excluded from
  `washSales` flags + `disallowedWashSaleLoss` and from `harvestCandidates`; new
  `TaxSummary.ledgerMismatchedSymbols` powers the footnote.
- `src/lib/dashboard.ts`: builds the position map from the broker chain **only when the
  portfolio/positions read succeeded** (a failed read must not flag every lot as an orphan) and
  passes it to `getTaxSummary`.
- `app/console/results/page.tsx`: **"ledger mismatch"** warn chip on affected open-lot rows +
  footnote naming the excluded symbols and count.

### Advisory-audit rate limiter
- `src/lib/dashboard.ts`: `auditAdvisoryRateLimited(kind, payload, ...)` — one audit row per kind
  per 6h window via the stamp-only `latestAuditStampByKind` read (payload never parsed), so an
  ongoing condition doesn't write a row per console refresh.

### Exact files touched
- `src/lib/cash-flows.ts`
- `src/lib/benchmark.ts`
- `src/lib/types.ts`
- `src/lib/tax.ts`
- `src/lib/dashboard.ts`
- `app/console/lib/derive.ts`
- `app/console/results/page.tsx`
- `test/benchmark.test.ts` (new describes: flow sanity bound, staleness gate)
- `test/tax.test.ts` (new describe: lot ledger vs live positions)
- `test/dashboard-fill-batching.test.ts` (benchmark module mock gains `computeSpyBenchmarkDetailed`)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note

## 3. Decisions & Trade-offs

- **Unverified ≠ deleted.** The suspect flow stays on the capital-regimes row with its amount and a
  warn chip; only the *math* stops trusting it. No dismiss/correct affordance yet (issue ask #2) —
  that needs a persisted owner-confirmation store; deferred, see Next Steps.
- **Bound constants** (5× / 2%) are the issue's suggested values; both exported so a future
  owner-tunable knob can wire straight in.
- **Wash-sale exclusions change display AND the disallowed aggregate, but NOT the enforcement
  lockout.** `lockedSymbols` / `getWashSaleLockedSymbols*` (the buy-gate path) are untouched —
  changing trade gating from a render-time reconciliation would be a money-path change this wave
  deliberately avoids. Consequence: for a mismatched symbol, ST/LT realized uses the recorded
  P&L *without* wash adjustments (flag filtered before `disallowedKeys`), and the footnote says the
  symbol's tax figures are unreliable.
- **`strategy.ts`'s `getTaxSummary` call not wired** with positions — changing LLM prompt context
  was out of scope for a display wave; the strategy path behaves exactly as before.
- **Stale-series returns unavailable rather than a truncated comparison** — a partially-frozen
  benchmark is a lie in either direction; ≤5 calendar days of lag (weekends/holidays/T+1) is normal
  and allowed.
- **Timeout of the benchmark fetch (4s deadline) is reported as `fetch-failed`** with a
  "timed out" detail — the user sees why the panel is empty even on a transient slow load; the 6h
  audit rate limit keeps that from spamming audit rows.
- **Magnitude-gap flagging (same sign, >5% off)** will also flag positions partially acquired
  outside the app. That is intended per the issue ("sign/magnitude disagrees"): tax math from a
  partial ledger is still wrong; the chip + footnote say so without blocking anything.
- **Node version note:** the shared `node_modules` better-sqlite3 binary is currently compiled for
  Node 26 (ABI 147) — the "run gates under node@24" memory is stale for suites that open SQLite;
  gates below ran under v26.6.0 (tsc is version-agnostic and also passed under 24).

## 4. Verification State

```bash
npx tsc --noEmit                                     # clean, no output
npx vitest run test/benchmark.test.ts test/cash-flows-deposit-invest.test.ts \
  test/tax.test.ts test/dashboard-fill-batching.test.ts \
  test/console-live-data-derive.test.ts              # 5 files, 99 tests, all pass
npx vitest run test/performance.test.ts test/performance-prefetched-pnl.test.ts \
  test/performance-payoff-stats.test.ts test/connected-account-performance-route.test.ts \
  test/dashboard-agentic-fallback.test.ts test/dashboard-snapshot-cache.test.ts \
  test/dashboard-ui.test.ts test/dashboard-feed.test.ts   # 8 files, 106 tests, all pass
npm run lint                                         # 0 errors, 728 warnings (grandfathered)
```

Full `npm test` + `npm run build` deliberately NOT run here — the landing operator owns the full
gate per this wave's process.

## 5. Next Steps & Blockers

- Landing operator: full gate (`npm run lint` → `tsc` → `npm test` → `npm run build`) + `land.sh`,
  PR referencing #2557 and #2548.
- #2557 ask #2 (owner dismiss/confirm affordance on unverified transfers) is NOT implemented —
  needs a small persisted confirmation store keyed by (account, date, amount); good follow-up issue.
- #2548 ask #2 (root-cause the T/AXP FIFO records — why the closes/side-flip never processed) is a
  separate forensic task on the paper account's Jul–Aug fills; this wave only stops the wrong
  numbers from rendering as truth.
- Watch prod audits for `benchmark_unavailable` (`stale-series` detail names the frozen source
  tier) — that is the alert on a dead SPY feed the issue asked for.

## 6. Zero-Code Findings

- The live SPY 0.00% almost certainly came from `fetchDailyOHLC`'s stale-local-bars fallback (it
  already writes an `eod_cache_stale` audit): every account date binary-searches to the same last
  stale close, so every sub-period factor is exactly 1. The staleness gate catches this shape
  regardless of which tier produced the frozen series.

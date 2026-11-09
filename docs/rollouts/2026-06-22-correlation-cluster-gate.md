# 2026-06-22 - correlation-cluster-gate

## Summary

Added an **optional** correlation cluster gate (`policy.maxAvgCorrelation`, 0–1, **default off**) —
the precise version of what the existing `maxPortfolioBeta` cap approximates. When set, an OPENING
buy/short is **skipped** (dropped before execution) if the candidate's average daily-return
correlation (Pearson over ~90 common trading days) to the current holdings exceeds the cap — i.e. it
would pile onto an already-correlated cluster the per-symbol / sector / beta caps don't see. Exits
and reductions (sell/cover) always pass; the gate is skipped (never false-rejects) when there isn't
enough overlapping bar data.

- New `src/lib/correlation.ts`: pure `closesByDate` / `alignedReturns` (date-intersection alignment,
  robust to holiday gaps) / `pearson` (with a zero-variance guard + [-1,1] clamp), and async
  `avgReturnCorrelation(candidate, holdings, userId, now, { fetchBars? })` which pulls ~5y daily bars
  via the shared `fetchDailyOHLC` cascade (injectable for tests) and averages the pairwise
  correlations, excluding the candidate itself.
- New `applyCorrelationClusterGate(proposals, policy, positions, userId)` in `strategy.ts`, wired into
  `runStrategyOnce` just before the execution loop (async, because correlation needs historical bars
  the synchronous policy gate can't fetch). Skips are logged + audited (`proposal_skipped_correlation`).
- Policy field `maxAvgCorrelation`, validated in `app/api/policy/route.ts` (0–1), and surfaced as an
  "Max avg correlation" Settings field next to "Max portfolio beta".

## Why

Owner-requested from the (closed) PR #89 review. The `maxPortfolioBeta` cap is the deliberate
data-light proxy for correlated-cluster risk (its own comment says so); this adds the real
daily-return correlation measure for operators who want the precision. The app already pulls daily
bars (`fetchDailyOHLC`), so no new data pipeline is needed. Off by default → zero behavior change
unless explicitly enabled.

## Files

- `src/lib/correlation.ts` — NEW (return/correlation math + `avgReturnCorrelation`).
- `src/lib/strategy.ts` — `applyCorrelationClusterGate` + wiring into `runStrategyOnce`.
- `src/lib/types.ts` — `TradingPolicy.maxAvgCorrelation?`.
- `app/api/policy/route.ts` — validation (0–1).
- `app/dashboard-client.tsx` — "Max avg correlation" field.
- `test/correlation-cluster-gate.test.ts` — NEW (8 tests): pearson edge cases, date-aligned returns,
  `avgReturnCorrelation` (averaging, candidate-exclusion, insufficient-data), and the gate's
  drop-correlated-opening / keep-exit / cap-off / no-holdings / below-cap paths.

## Verification

In `~/apps/trading-corr` (branch `feat/correlation-cluster-gate`, base `origin/main`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — **1006 passed** (+8).
- `npm run build` — clean (exit 0; real `npm ci` install — the Turbopack build rejects a node_modules symlink).

## Follow-ups

- The gate **rejects** an over-correlated opening rather than downsizing it (consistent with the
  beta cap). A downsizing variant could be a future refinement, but reject is the simpler, safer
  default and matches the existing risk-cap semantics.
- Correlation uses equal-weight averaging over holdings; a value-weighted variant is possible later.

## Blockers

- None.

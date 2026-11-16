# Rollout — 2026-06-22 Learning-Loop Hardening

Branch: `agent/claude-h-learn`

## Summary

Four focused improvements to the strategy learning loop:

1. **OOS walk-forward gate** — `proposeStrategyTuning` now runs `runWalkForwardOOS` on any proposal
   that includes `scoringWeights`. If OOS IC does not improve over the default weights the patch
   strips `scoringWeights` and emits a caution mirroring the existing
   "Withheld model-proposed factor-weight changes" guard.

2. **Regime-segmented tuning evidence** — before calling `getFactorScorecard`, the tuner derives
   the current market regime from the most-recent closed lot and, when that regime bucket has ≥ 20
   lots, uses only same-regime evidence. Falls back to all-regime aggregate when the bucket is too
   thin.

3. **Holding-period / turnover visibility (read-only)** — `aggregateClosedLots` now derives
   `avgDaysHeld` (average calendar days held) and `shortTermPct` (% of lots held < 365 days) from
   `lot.entryAt`/`lot.exitAt`. Both are exposed as optional fields on `FactorScorecardStat`,
   `ThesisStat`, `RegimeStat`, `SectorStat`, and `ThesisRegimeStat`. Neither field feeds into
   weight-nudge math — display/diagnostic only.

4. **Execution-cost model ON by default** — `executionCostConfig()` in `execution-cost.ts` now
   returns `enabled: true` when no env is set (was `false`). Default base slippage was 1 bps
   at this checkpoint; current default is the shared `OOS_ROUND_TRIP_COST_BPS` (20). See
   `docs/rollouts/2026-08-18-paper-live-pooling-cost.md`.
   Explicit opt-out: `PAPER_EXECUTION_COST_MODEL=0|false|off|no`.

## Why

- OOS gate: weight patches derived from in-sample data can overfit; gating on OOS IC prevents
  the learning loop from certifying an edge that evaporates out-of-sample.
- Regime-segmented evidence: a factor that works in Tech-Bull may not in Choppy — mixing regimes
  dilutes the signal and nudges weights in the wrong direction.
- Holding-period fields: tax-lot awareness and turnover are diagnostic signals the operator
  needs to see when reviewing scorecard output; they're cheap to surface and carry no risk of
  feedback into sizing math.
- Default-on costs: simulated fills at frictionless mid-quote inflate win rates and edge, causing
  the loop to oversize into exactly the thin, high-momentum names where live cost is worst. 1 bps
  is conservative but non-zero.

## Files touched

- `src/lib/execution-cost.ts` — `executionCostConfig` default-on + `DEFAULT_BASE_SLIPPAGE_BPS = 1`
- `src/lib/performance.ts` — `aggregateClosedLots` avgDaysHeld/shortTermPct; optional regime filter
  on `getFactorScorecard`; new optional fields on `ThesisStat`, `RegimeStat`, `SectorStat`,
  `ThesisRegimeStat`, `FactorScorecardStat`, `FactorScorecardOptions`
- `src/lib/strategy-tuning.ts` — `applyOosGate` helper + OOS call on both local and LLM paths;
  `currentRegimeFromLots` helper + regime-filtered scorecard selection
- `test/execution-cost.test.ts` — rewrite default-ON describe block; add explicit opt-out test
- `test/performance.test.ts` — updated buy/short price assertions for 1 bps cost;
  added `describe("holding-period fields (Task 3)")` with 2 new tests
- `test/strategy-tuning.test.ts` — `vi.fn` OOS mock at top; `describe("OOS walk-forward gate
  (Task 1)")` with 2 tests; `describe("regime-segmented tuning evidence (Task 2)")` with 2 tests
- `docs/rollouts/2026-06-22-learning-loop-hardening.md` (this file)

## Verification

```
cd /Users/jay/apps/trading-h-learn

npx tsc --noEmit           # 0 errors (excluding pre-existing alternative-data.test.ts)
npx vitest run             # 811 tests / 90 files — all pass
```

`npm run build` was not run (no `app/` changes; tsc + vitest is the authoritative check for
library-layer work per AGENTS.md).

## Follow-ups

- `avgDaysHeld`/`shortTermPct` are available on the scorecard return types; wire into the
  dashboard stat display when the UI phase picks up turnover visibility.
- The OOS gate silently no-ops when `runWalkForwardOOS` throws or returns null (< 4 unique
  snapshot dates). Consider surfacing a caution in that case so operators know the gate was
  skipped.
- Regime-segmented evidence falls back gracefully when no regime field is populated on closed
  lots. Add a migration or back-fill note if older lots need a regime tag.
- `PAPER_EXECUTION_COST_MODEL=off` is the opt-out for frictionless test environments; document
  in the `.env.example` if not already present.

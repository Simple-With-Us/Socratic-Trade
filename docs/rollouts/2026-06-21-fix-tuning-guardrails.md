# 2026-06-21 — Fix strategy-tuning guardrails: LLM weight delta clamp + factor-outcome wiring

## Summary

Two guardrail gaps in `src/lib/strategy-tuning.ts` were identified and fixed:

1. **LLM weight-tuning path lacked a per-factor delta clamp.** `toPatch()` called
   `pruneNumeric()` to strip null values but applied no step-size clamp, meaning an LLM
   could propose any weight regardless of how far it deviated from the current value. The
   local-rules path uses 0.1–0.2 deltas by convention; the docs mandate a strict maximum.

2. **`getFactorScorecard()` outputs were never fed into the tuner.** The function exists in
   `performance.ts` (line 594) and produces realized win-rate/avg-return grouped by dominant
   entry factor — but `strategy-tuning.ts` never imported or called it. The learning loop
   for factor outcomes was therefore open: factor attribution influenced the LLM context via
   `missedOpportunities`, but the actual per-factor P&L scorecard was invisible.

## Why / Decisions

### Clamp value: ±0.05

Phase-7 §3.E states "Maximum 5-point weight delta per factor suggestion."
`strategic-framework.md` §5 states "no more than a 5-point change per factor at a time"
and gives the example "trust fundamentals 5% less, technicals 5% more."

The `DEFAULT_SCORING_WEIGHTS` run on a 0.6–1.4 multiplier scale. Mapping "5 points" to
this scale: treating each 0.01 increment as one point yields 0.05 per step. This is
intentionally tighter than the local-rules 0.1–0.2 deltas — the LLM path has no inherent
pressure to keep steps small, so the clamp is the defensive choice. The value `0.05` is
exported as `MAX_WEIGHT_STEP` so tests can reference it symbolically.

### Factor-scorecard wiring: minimal-correct implementation

Rather than a large architectural change, the safest approach was:
- Compute `factorScorecard` from `getFactorScorecard()` in `proposeStrategyTuning()`,
  gated by the existing `minClosedLotsForWeightShift` guardrail (below the gate the
  per-factor sample is too thin).
- Surface it in the LLM tuning context as `factorScorecard` so the model can reason about it.
- In `localRulesProposal()`: apply a ±`MAX_WEIGHT_STEP` nudge per factor with enough trades
  (≥ 3): downward for negative avg return, upward for shrunk win rate ≥ 60% AND positive avg
  return. Nudges override the general weak-performance adjustment for the specific keys they
  cover; a caution message is added for each nudge applied.
- Both paths remain REVIEW-ONLY (proposals the user manually applies — never auto-applied).

## Files Changed

- `src/lib/strategy-tuning.ts`
  - Added `MAX_WEIGHT_STEP = 0.05` export and `MarketFactor` type import
  - Added `getFactorScorecard, FactorScorecardStat` import from `./performance`
  - `proposeStrategyTuning()`: compute `factorScorecard`, include in LLM context + local-rules call
  - `toPatch()`: added `currentWeights?: ScoringWeights` parameter; clamp each proposed
    weight to `[current - MAX_WEIGHT_STEP, current + MAX_WEIGHT_STEP]`
  - `localRulesProposal()`: added `factorScorecard?: FactorScorecardStat[]` input;
    added factor-nudge logic with caution messages
- `test/strategy-tuning.test.ts`
  - Updated "sanitizes nullable LLM tuning fields" expected values to match clamped weights
    (liquidity: 1.45, quality: 0.85, sentiment: 0.65 — each current ± 0.05)
  - Added "clamps LLM-proposed scoringWeight deltas to MAX_WEIGHT_STEP" test: custom all-1.0
    weights, LLM proposes 2.5 and 0.0, asserts clamped to 1.05 and 0.95 respectively
  - Added "localRulesProposal factor scorecard integration" describe block verifying that
    the base weak-performance rules still fire when no signal_snapshot audits exist

## Verification

```
npx tsc --noEmit   → clean (0 errors)
npm test           → 774 passed (85 test files)
npm run build      → clean (Next.js static/dynamic routes all compiled)
```

## Follow-ups

- The local-rules nudge uses a fixed ±`MAX_WEIGHT_STEP` regardless of how strong the
  signal is. A future improvement could scale the nudge by magnitude of underperformance
  (e.g. proportional to `|avgReturnPct|`) while still clamping at MAX_WEIGHT_STEP.
- The LLM path now receives `factorScorecard` in context but the system prompt has no
  explicit instruction about it. A follow-up could add guidance: "use factorScorecard to
  support or discount factor weight changes — factors with negative avgReturnPct should
  receive downward pressure."
- The per-factor nudge minimum-sample threshold (3 trades) is hard-coded. This could be
  made configurable via `policy.tuning.minTradesPerFactorNudge`.

# 2026-06-21 — Walk-forward OOS validation + cost+tax-adjusted equity curve vs SPY

## Summary

Implemented P1-1b: out-of-sample validation of the IC-derived factor weights, with
transaction-cost and tax adjustment, equity curve, and SPY benchmark comparison.
This is the core missing proof that the strategy's edge survives real friction OOS.

## What changed

### `src/lib/backtest.ts` (extended, backward-compatible)

Four new **pure** exported functions (all Date.now()-free, fully unit-testable):

- **`splitWalkForward(observations, trainFraction=0.7)`**  
  Chronological walk-forward split by unique snapshot date. The first `trainFraction`
  of dates → train set (IC derivation); the rest → test set (OOS evaluation). Never
  puts the same date in both groups; always keeps ≥1 date in train.

- **`adjustReturns(observations, { costRoundTripBps=20, taxRate=0.24 })`**  
  Debits estimated round-trip transaction cost (default 20 bps = 10 bps/leg) and
  applies short-term capital-gains tax drag to positive after-cost returns:  
  `net = (gross − cost) × (1 − taxRate)` for gains; `gross − cost` for losses.

- **`computeCompositeIC(observations, weights)`**  
  Computes the Spearman rank IC of a weighted-sum composite score vs forward return
  per date, then returns `{ meanIC, icIR }` where ICIR = mean / sample-std across OOS
  dates. ICIR > 0.5 is the conventional signal-quality threshold.

- **`buildEquityCurve(oosObservations, weights, spyReturnByDate, topK=3)`**  
  On each OOS date, scores all names with `weights`, takes the top-K, and records
  their mean net return as the period return. Compounds cumulatively. SPY benchmark
  accumulated in parallel. Returns `EquityCurvePoint[]`.

One new **IO** function:

- **`runWalkForwardOOS(userId, options)`**  
  Orchestrates the full pipeline: fetch signal_snapshot observations → split →
  derive IC weights from train → measure OOS composite IC + ICIR with IC weights
  AND with default weights (baseline to beat) → fetch SPY bars → build equity curve.
  Returns annualizedReturn, benchmarkAnnualizedReturn, activeReturn, sharpeRatio,
  maxDrawdownPct. Returns **null** when <4 unique snapshot dates (insufficient data
  for a meaningful split).

### `app/api/admin/backtest-ic/route.ts` (updated)

`GET /api/admin/backtest-ic` now includes an `oos: {...}` block by default. Pass
`?oos=false` to skip. New query params: `trainFraction`, `costRoundTripBps`,
`taxRate`, `topK`.

Response shape:
```json
{
  "ok": true,
  "informationCoefficients": [...],
  "suggestedWeights": {...},
  "oos": {
    "oosIC": 0.12,
    "oosICIR": 0.73,
    "oosICDefault": 0.08,
    "icWeights": {...},
    "equityCurve": [...],
    "annualizedReturn": 0.18,
    "benchmarkAnnualizedReturn": 0.14,
    "activeReturn": 0.04,
    "sharpeRatio": 1.1,
    "maxDrawdownPct": 8.3,
    "note": "Walk-forward: 35 train dates → IC weights; 15 OOS dates (20bps cost, 24% tax). Top-3 names/date."
  }
}
```

## Files touched

- `src/lib/backtest.ts` — +337 lines (OOS functions + interfaces)
- `test/backtest.test.ts` — +166 lines (+25 tests)
- `app/api/admin/backtest-ic/route.ts` — +45 lines (OOS query params + response block)

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 541 tests, all pass (+25 new)
- Commit: `34ec168`

## Design notes

- The equity curve uses overlapping holding periods (standard IC-backtest convention):
  each snapshot date is an independent cross-section. This overstates turnover if
  snapshot cadence < horizonDays, but is correct for measuring signal predictive power.
- `adjustReturns` uses the P1 financial-panel default: 20 bps round-trip (10 bps/leg),
  24% short-term rate. Both are configurable via API params.
- SPY benchmark requires `signal_snapshot` observations to have matured OHLC data
  (same horizon). If SPY bars are unavailable, benchmark fields are null — the equity
  curve still runs.
- `runWalkForwardOOS` returns null (not an error) when there are <4 unique snapshot
  dates, which is the minimum for a meaningful 70/30 split.

## Follow-ups

- Remaining P1 items: congress/insider windowing on `disclosedAt`, sample-aware
  learning (n≥20 before bucket drives sizing), independent critique stage.
- The OOS equity curve is informational (advisory) — it does NOT auto-apply IC weights;
  that still goes through the auto-tuner's 20-closed-lot gate.

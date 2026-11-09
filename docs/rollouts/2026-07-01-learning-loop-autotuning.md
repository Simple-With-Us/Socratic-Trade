# 2026-07-01 — Learning loop / auto-tuning (Workstream B)

Branch `agent/claude-workstream-b-learning-v2`. Implements all 8 items of "Chat B — Learning
loop / auto-tuning" from `docs/reviews/2026-07-01-audit-work-split.md`, INCLUDING the mid-flight
16-expert-panel design corrections (`docs/reviews/2026-07-01-learning-loop-expansion.md`, B1–B8).
Every behavior change is behind a **default-off** `policy.tuning.*` flag EXCEPT the B8 execution-cost
correctness fix (a real bug), so the Phase-0 byte-identical invariant otherwise holds when flags are off.

## Panel corrections folded in (B1–B8)
- **B1** autonomous apply: stricter-than-manual OOS gate (min IC-delta margin + candidateIC>0 + ICIR floor
  + min test-dates; null OOS = HARD no-apply); WRITE-SCOPE SAFETY (applies `proposedPatch.scoringWeights`
  ONLY — never the patch's policy/risk/strategyAuthority/prompt sub-fields); cadence hosted in `scheduler.ts`
  under the single-leader gate (NOT `triggers.ts`); persists only via `setPolicy`; re-clamps ±MAX_WEIGHT_STEP
  POST-normalization.
- **B2** congress gate: THREE-WAY verdict — PASS(1) / FAIL_SIGNIFICANCE(0, down-weight) / INSUFFICIENT(1,
  neutral) — so a data-poor account's no-go is NOT a permanent congress kill-switch; gates both inclusion
  (`outlierInterestScore`) and the composite overlay.
- **B4** SPY-relative misses: reuses the backtest SPY fetch (new exported `buildSpyReturnToNowMap`), per-row
  entry→now window, excess return injected in `getSkippedCandidateReturns` (summarize stays pure), missing
  SPY row = EXCLUDE (never raw >0 fallback), recurring threshold ≥5 counted over full winners.
- **B5** factor attribution: persists `dominantFactor` at ENTRY on the fill raw (mirrors the sector stamp),
  read FIRST by `getFactorScorecard` — fixes the real coverage-decay hazard (entry snapshot aging out of the
  500-row `listAudit` window); dead `?? "momentum"` fallback removed.
- **B6** calibration→sizing: uses `shrunkWinRate`, reduce-only, ISOTONIC (pool-adjacent-violators) clamp
  across bands so a low-N mid band can't invert ordering, per-band sample gate (`minClosedLotsForWeightShift`),
  shorts fall back to RAW (long-only calibration), composed as a reduction feeding the existing conviction-cap
  MIN, computed ONCE per run.
- **B7** per-regime: report-only (unchanged decision), flat `policy.scoringWeights` NOT reshaped.
- **B8** REAL BUG FIX (not test-only): `synthetic-stops.ts` and `order-replacement.ts` inserted paper/test
  EXIT fills at the raw price with NO execution cost, so a paper lot exited via a synthetic stop paid no exit
  cost and overstated realized edge on the losing tail (which feeds the tuner + sizer). New
  `applyPaperExitCost` (execution-cost.ts) applies the EXIT-side cost to paper exits in both writers; live
  fills unchanged.

## Coordination note
The branch `agent/claude-workstream-b-learning` (worktree `agent-acccad8737faf154d`) was a
STOPPED sibling agent's leftover with uncommitted edits — confirmed by the orchestrator as not a
live competing session. This work was implemented FRESH on `-v2` (not salvaged from those edits);
the orphaned worktree/branch was left untouched for the human to clean up. Red Team / inline-Bear /
adversary code (`src/lib/red-team.ts`, the inline Bear block in `strategy.ts`) was NOT touched —
that's owned by a separate session. Item 3 was integrated at the `market.ts scoreFactors` seam (via
the scan-scoring weights passed into `scanMarket`) rather than in `strategy.ts`'s prompt block, to
minimize collision with the Red Team session's heavy `strategy.ts` edits.

## Summary (what changed, per item)

1. **Opt-in autonomous factor-weight tuning.** New `policy.tuning.autoApplyWeights` (default off).
   New `applyAutonomousWeightTuning(userId)` + `revertAutonomousWeightTuning(userId)` in
   `strategy-tuning.ts`: runs `proposeStrategyTuning` (which already clamps every delta to
   `MAX_WEIGHT_STEP` in `toPatch` AND runs the OOS walk-forward gate in `applyOosGate`), and only if
   `scoringWeights` SURVIVED the gate does it persist via `setPolicy` + write an `auto_weight_apply`
   audit row carrying the PRIOR full vector for revert. Cadence gate in new
   `auto-tune-scheduler.ts` (`maybeAutoTuneWeights`, default 24h via `AUTO_TUNE_MIN_INTERVAL_HOURS`),
   called after a successful run in `scheduler.ts` and `triggers.ts` (self-guarded; can't break a run).
   An unvalidated weight move is never applied (gate strips it → `no_validated_weight_changes`).

2. **Congress-score go/no-go gating.** New `policy.tuning.congressGoNoGoGating` (default off). New
   `congress-score-gate.ts`: caches the `evaluateCongressScore` verdict in the `settings` table
   (`storeCongressScoreVerdict`), reads it cheaply at scan time (`readCongressScoreVerdict`, 14-day
   staleness → fail-open), and yields a pure `congressGateMultiplier` (1 = no change / stale / GO;
   0 = fresh NO-GO). Threaded into `market.ts`: `outlierInterestScore`/`hasNotableWebSignal` take an
   optional `congressMultiplier`, and the scan zeroes the congress composite + skips the senateTrades
   overlay when the multiplier is 0. New admin route `app/api/admin/congress-score-eval/route.ts`
   (GET = read cached, POST = recompute+cache). Verdict surfaced on the dashboard snapshot under
   `smartMoney.congressScoreVerdict`.

3. **Matured missed-opportunity nudge into scan composite.** New `policy.tuning.missedOpportunityNudge`
   (default off). New pure `applyMissedOpportunityNudge(weights, summary)` in `strategy-tuning.ts`
   bumps a recurring benchmark-beating factor's weight by `MAX_WEIGHT_STEP` (transient — this-run
   scan scoring only, NOT persisted). New `resolveScanScoringWeights(...)` in `strategy.ts` applies it
   before the scan, gated by the closed-lot sample gate, and audits `missed_opportunity_nudge`.

4. **Hardened `recurringFactor`: ≥5 + benchmark-relative.** New `policy.tuning.benchmarkRelativeMisses`
   (default off) + `recurringFactorMinCount`. `summarizeMissedOpportunities` now takes an options object
   (bare-number `limit` still works): benchmark-relative mode requires `returnPct − benchmarkReturnPct
   > 0` (a name that beat 0 but lagged SPY is no longer a "winner") and raises the recurring bar to 5.
   SPY return is annotated per row via `benchmarkAnnotateMissedRows` + `spyReturnPctBetween` (SPY OHLC
   fetched once in `proposeStrategyTuning`). Default path (`returnPct > 0`, recur ≥2) unchanged.

5. **Factor attribution no-momentum-default.** `getFactorScorecard` (`performance.ts`) previously
   resolved an unresolvable lot factor to `"momentum"` (`?? "momentum"`). Replaced with explicit
   resolution: a lot whose dominant entry factor can't be resolved (no `entryRunId`, or its
   `signal_snapshot` aged out of the 500-row audit cap) is DROPPED, never mislabeled as momentum. (The
   old fallback was dead for the `.filter`ed lots but is now provably impossible.)

6. **Confidence calibration → sizing.** New `policy.tuning.calibrationSizing` (default off). New pure
   `calibratedConviction(confidenceScore, calibration)` + exported `confidenceBandOf` in
   `performance.ts`: remaps conviction DOWNWARD toward the band's realized shrunk win rate (never
   inflates; ignores bands with <5 trades). Wired into `applyDeterministicSizing` at the
   `rawConviction` line (tightly localized) — flag off = raw `confidenceScore/100` as today. Still
   respects `convictionCapUncorroborated`.

7. **Per-regime factor weights (stretch) — REPORT ONLY, application intentionally OFF.** Added a
   `regime` field to `FactorObservation` (stamped from the signal_snapshot) and a pure
   `computePerRegimeFactorICs(observations, minDates=8)` in `backtest.ts`, surfaced in the admin
   `backtest-ic` route as `perRegimeICs` with a `sufficient` flag. **Application of regime-conditioned
   weights is deliberately NOT wired** — see the sample-size call below. New
   `policy.tuning.perRegimeWeights` flag exists but has no application path yet (documented).

8. **Execution-cost integrity (verification).** Confirmed `applyExecutionCost` (`execution-cost.ts`,
   default ON for simulated paper fills) is in `recordFillFromProposal` (`performance.ts:183`), whose
   fills feed `calculatePnl`'s closed-lot returns → the tuner (`getFactorScorecard`,
   `summarizeMissedOpportunities`) and the sizer (`getThesisScorecard`/calibration). So the learner
   certifies a COST-AWARE edge. No code change needed; added a regression test proving a paper buy
   fills a hair above the quote and a same-price close yields a negative (cost-drag) realized return.

## Why
The audit found these learning loops "built but never wired into the money path." This wires them in
behind default-off, statistically-gated, clamped, audited flags so the app can learn from its own
outcomes without unsafe overfitting — while keeping default behavior byte-identical.

## Item 7 per-regime sample-size call (explicit, as required)
Application is left OFF. This is a paper-research app whose closed-lot / signal-snapshot history per
regime bucket is almost always far below the sample size needed for a trustworthy per-regime IC (the
report's `sufficient` bar is ≥8 distinct snapshot dates per regime, which real data here rarely
clears). Conditioning the LIVE scan weights on such thin buckets would overfit regime labels. The
responsible deliverable is therefore the admin-side per-regime IC **report** only; the
`perRegimeWeights` flag is a placeholder for a future, sufficiency-gated application path.

## Files
New:
- `src/lib/congress-score-gate.ts` — cached THREE-WAY congress verdict + pure multiplier.
- `src/lib/auto-tune-scheduler.ts` — cadence gate for autonomous weight tuning (scheduler-hosted).
- `app/api/admin/congress-score-eval/route.ts` — compute/cache/read the congress verdict.
- `test/learning-loop-autotuning.test.ts` — pure-helper tests (items 2,3,4,6,7 + isotonic + classify).
- `test/learning-loop-autotuning-db.test.ts` — DB-backed tests (items 1,2,4,5,6,8 incl. B8 round-trip).

Changed:
- `src/lib/types.ts` — 7 new default-off `TuningSettings` flags + `MarketDataProviderOptions.congressMultiplier`.
- `src/lib/strategy-tuning.ts` — items 1,3,4: hardened autonomous apply/revert (write-scope + stricter OOS), nudge helper, benchmark-relative summarize (SPY injected via getSkippedCandidateReturns).
- `src/lib/strategy.ts` — items 1,2,3,6: `resolveScanScoringWeights`, congress multiplier resolution, calibration-remapped conviction (once-per-run, shorts→raw).
- `src/lib/performance.ts` — items 5,6,B4: entry-stamped `dominantFactor` + read-first attribution, isotonic `calibratedConviction`/`confidenceBandOf`, SPY-excess injection in `getSkippedCandidateReturns`.
- `src/lib/market.ts` — item 2: `congressMultiplier` threaded through `outlierInterestScore`/`hasNotableWebSignal`/scan composite + `scanMarket`.
- `src/lib/backtest.ts` — item 7 + B4: `regime` on `FactorObservation`, `computePerRegimeFactorICs`, exported `buildSpyReturnToNowMap`.
- `src/lib/execution-cost.ts` — B8: new `applyPaperExitCost` (exit-side cost for paper/test).
- `src/lib/synthetic-stops.ts`, `src/lib/order-replacement.ts` — B8: apply exit cost to paper/test exits.
- `src/lib/dashboard.ts` — item 2: surface `smartMoney.congressScoreVerdict`.
- `src/lib/scheduler.ts` — item 1: call `maybeAutoTuneWeights` after a successful run (under the leader gate).
- `src/lib/triggers.ts` — item 1: explicitly does NOT host auto-tune (comment only; wrong cadence semantics).
- `app/api/admin/backtest-ic/route.ts` — item 7: `perRegimeICs` in the response.
- `test/strategy-tuning-missed-opps.test.ts` — unchanged (default path preserved; still passes).

## Verification (commands actually run, in order — AFTER panel corrections)
- `npx tsc --noEmit` → EXIT 0 (no errors).
- `npm run lint` → EXIT 0 (0 errors; 259 grandfathered warnings; 0 new in the source files).
- `npm test` → 174 files / 1710 tests, all passing (includes the new learning-loop tests + the unchanged
  existing tuning/synthetic-stops/order-replacement tests proving default behavior is preserved).
- `npm run build` → EXIT 0 ("Compiled successfully in 47s"; full Next.js build green post-corrections).

## Follow-ups / risks
- **Item 3 hot-path benchmark annotation deferred.** `resolveScanScoringWeights` (the per-scan nudge)
  does NOT fetch SPY per run (would add a SPY OHLC fetch to every scan). When an operator opts into
  `benchmarkRelativeMisses`, the scan-hot-path nudge's recurring-factor gate simply won't fire unless the
  SPY-relative winner set materializes without benchmark data — the safe direction (no nudge). The tuner's
  own `proposeStrategyTuning` path DOES use the reused SPY fetch. Consider caching a per-scan SPY series if
  the hot-path nudge should be benchmark-relative.
- **Congress verdict must be refreshed** (offline eval or the new admin route `POST /api/admin/congress-score-eval`)
  before gating has anything to act on; a never-computed or >14d-stale verdict fails open (no gating) by
  design, and a data-poor account resolves to INSUFFICIENT (neutral), never a permanent kill-switch.
- **Item 7 application** remains a future, sufficiency-gated feature (report-only now).
- **Autonomous apply cadence** defaults to 24h (`AUTO_TUNE_MIN_INTERVAL_HOURS`), runs under the scheduler's
  single-leader gate; the stricter autonomous OOS gate needs ≥4 test dates + a positive IC-delta margin +
  ICIR floor, so on a fresh/thin account it correctly applies nothing until enough history exists. Env knobs:
  `AUTO_TUNE_MIN_IC_DELTA` (0.005), `AUTO_TUNE_MIN_CANDIDATE_IC` (0), `AUTO_TUNE_MIN_ICIR` (0.2),
  `AUTO_TUNE_MIN_TEST_DATES` (4).
- **B8 scope note:** `applyPaperExitCost` uses base-slippage only (no live scan quote is available at
  stop/replacement time), matching the entry path's behavior when spread/volume are absent. If a richer
  cost model is wanted for exits, thread a quote through those writers.
- **Panel P1/P2 backlog** (from the expansion doc) — deeper improvements (e.g. richer OOS significance
  testing, per-band Wilson intervals for calibration, sparse-dense congress signal) are noted there as
  future work, not in scope for this PR.

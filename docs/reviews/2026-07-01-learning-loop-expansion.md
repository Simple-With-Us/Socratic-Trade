# Learning Loop / Auto-Tuning — Expansion Design

**Status:** design / expansion (2026-07-01)
**Domain:** Learning Loop / Auto-Tuning (factor-weight tuning, congress-score validation, counterfactual/missed-opportunity stats, confidence calibration, per-regime weights, execution-cost integrity)
**Owner lane:** Chat B (see `docs/reviews/2026-07-01-audit-work-split.md` §"Chat B — Learning loop / auto-tuning")

## Summary

This doc consolidates a multi-lens expert panel (quant/statistician, trading &
risk, software architecture), a skeptic pass, and a completeness pass into (A) a
prioritized backlog of **new** improvements for the learning loop that survived
skepticism, and (B) the must-fix design corrections to relay to the Workstream B
implementer who is executing the audit items (B1–B8).

The through-line: audit item **B1** turns `proposeStrategyTuning` into the
first-ever *autonomous* writer of `policy.scoringWeights`. Everything here
exists to make that safe — leakage-free validation, effect-size/multiplicity
gates, forward-validation before trust, a uniform audit+revert ledger, a
dry-run on-ramp, a fail-closed config guard, and a hard scoping rule that the
autonomous path may write **weights only** (never risk caps or
`strategyAuthority`).

Every new item is **default-off** and preserves the Phase-0 byte-identical
invariant when its flag is unset.

## Relationship to the audit workstream

The audit work-split (`docs/reviews/2026-07-01-audit-work-split.md`, Chat B)
enumerates items B1–B8:

- **B1** Opt-in autonomous factor-weight tuning (cadence-gated `applyOosGate` + persist)
- **B2** Wire `congress-score-eval` go/no-go into scan/scoring
- **B3** Feed matured counterfactual/missed-opportunity stats into scan composite / Bull prompt
- **B4** Harden `recurringFactor`: raise threshold (≥5) + SPY-relative winner test
- **B5** Fix factor attribution defaulting to `"momentum"`
- **B6** Feed confidence calibration into sizing
- **B7** Per-regime factor weights (stretch)
- **B8** Verify execution-cost not bypassed in learner inputs

This doc does **not** re-scope B1–B8; it (1) corrects specific pitfalls in how
they are implemented (§Item-refinement corrections) and (2) adds new work that
brackets them for safety (§New-improvement backlog).

Grounding files (verified this pass): `src/lib/strategy-tuning.ts`,
`src/lib/backtest.ts`, `src/lib/performance.ts`, `src/lib/execution-cost.ts`,
`src/lib/market.ts`, `src/lib/macro.ts`, `src/lib/congress-score-eval.ts`,
`src/lib/synthetic-stops.ts`, `src/lib/order-replacement.ts`,
`src/lib/db-profiles.ts`, `src/lib/scheduler.ts`, `src/lib/types.ts`.

---

## Item-refinement corrections (must-fix for the Workstream B implementer)

These are pitfalls that will produce a *wrong or unsafe* implementation of the
audit items if not heeded. Each is code-grounded.

### B1 — the OOS gate is not an autonomous-apply gate as-is

- **`applyOosGate` uses a bare point-estimate inequality.**
  `src/lib/strategy-tuning.ts:325` is `const improves = candidateIC > baselineIC;`
  — no margin, no significance, no ICIR floor. A +0.0001 IC edge on a noisy
  30% test fold passes. For an autonomous cadence caller you must add: a minimum
  IC-delta margin, `candidateIC > 0` in absolute terms (never persist a vector
  that is merely *less negative* than a losing baseline), an `oosICIR` floor
  (`runWalkForwardOOS` already returns `oosICIR`, `backtest.ts:427,659`), and a
  minimum test-date count. Keep the manual proposal path on the looser gate; the
  autonomous path must be strictly stricter.
- **Host the cadence in `scheduler.ts`, not `triggers.ts`.** `triggers.ts` is
  the event-driven engine (default-off `TRIGGER_ENGINE`); wiring tuning there
  couples weight learning to news debounce and does nothing when the flag is
  off. `src/lib/scheduler.ts` already has per-account cadence clocks
  (`lastRunAt`, line ~40/100), a single-leader gate
  (`SCHEDULER_SINGLE_LEADER`, line ~150), and calls `runStrategyOnce`. Add a
  sibling on a **separate, much slower** cadence (e.g. daily / every-N-runs via
  its own settings key), gated behind the same leader check to avoid a
  double-apply under the lease TOCTOU window.
- **Persist only through `setPolicy` (`db-profiles.ts:412`).** A bespoke
  `writeAccountStrategyState` call desyncs `account_strategy_state` from the
  active-profile mirror. `setPolicy` fans out to both via
  `mirrorPolicyToActiveAccount`.
- **Re-clamp AFTER normalization.** `applyOosGate` merges the proposed patch
  over current weights then calls `normalizeScoringWeights`, which
  re-normalizes the whole vector — a per-factor delta that was clamped to
  `MAX_WEIGHT_STEP` (`strategy-tuning.ts:41,580`) pre-normalization can exceed
  ±0.05 *post*-normalization. Assert the clamp on the normalized candidate read
  immediately before `setPolicy`.
- **`null`/insufficient OOS is a HARD no-apply.** `runWalkForwardOOS` returns
  `null` below 4 unique snapshot dates (`backtest.ts` ~633); the autonomous
  path must treat this as no-apply regardless of `oosWithholdUnvalidated`.
- **Scope the write to `scoringWeights` ONLY.** `StrategyTuningPatch`
  (`types.ts:997`) also carries `policy` (maxOrderNotional, maxDailyNotional,
  `strategyAuthority`, riskRules, sectorCaps) and a free-text `prompt`, none of
  which `applyOosGate` gates. Applying the whole patch would let an LLM
  proposal autonomously loosen a risk cap or flip `strategyAuthority` to
  `"decide"` with zero gate. This is the single largest hole B1 opens — see
  backlog **P0-1**.

### B2 — distinguish "no-go: insufficient data" from "no-go: failed significance"

`evaluateCongressScore` (`congress-score-eval.ts`) requires ~500 observations /
60 dates / 50 tickers and `requireBenchmarkReturn`. A fresh paper account will
almost always return no-go for *lack of data*. Gating naively on `goNoGo.pass`
turns the flag into a permanent congress kill-switch. Treat the verdict as
three-state — PASS (full weight) / FAIL-on-significance (down-weight) /
INSUFFICIENT (neutral, keep current behavior) — and only FAIL down-weights.
Compute the verdict **out of the scan hot path** (it does OHLC IO); cache it as
a settings blob with an `asOf` and treat an expired verdict as INSUFFICIENT.
Gate **both** injection points: the `outlierInterestScore` congress branch
(`market.ts:44`, inclusion) **and** the `scoreCongressSignal` overlay
(`market.ts:332`, composite contribution) — gating only one is a half-fix.

### B4 — SPY window must be per-row, and missing-benchmark rows must be excluded

`summarizeMissedOpportunities` filters winners with `returnPct > 0`
(`strategy-tuning.ts:109`) with no benchmark. Reuse the existing SPY machinery
(`buildSpyReturnMap` / `fetchDailyOHLC('SPY')` in `backtest.ts`); do **not**
hand-roll a second SPY fetch. Thread a per-row excess return computed over the
**same** entry-date→now window as that row (variable `ageDays`), not one global
SPY figure. Keep `summarizeMissedOpportunities` **pure** — inject the excess
return upstream in `getSkippedCandidateReturns` (`performance.ts`). When SPY is
unavailable for a row, **exclude** it (do not silently fall back to raw
`returnPct > 0`, which re-admits the bug). The `≥2 → ≥5` threshold is a
one-line change at `strategy-tuning.ts:134`; the count is computed over the full
`winners` array *before* `.slice(0, limit)` (line 122), so raising the count
does not require raising `limit`.

### B5 — the real bug is the 500-row audit cap, not the `?? "momentum"` line

The `?? "momentum"` fallback in `getFactorScorecard` (`performance.ts:708`) is
**dead** in the current call site (the preceding `.filter` requires
`factorByKey.has(key)`). The actual hazard is `listAudit(500, …)`
(`performance.ts:687`): as history grows, a lot whose entry `signal_snapshot`
ages out of the most-recent-500 audit rows is silently *excluded* from factor
attribution, decaying coverage on the oldest, most-valuable closed lots. Fix by
**persisting `dominantFactor` at entry** on the fill's raw payload (mirror the
existing sector-at-entry stamp), then read it first and fall back to the audit
join only for legacy lots. Remove the dead `?? "momentum"` so future direct
callers fail loud. Do **not** touch `getSkippedCandidateReturns`
(`performance.ts:803`) — it has no fallback and correctly propagates `undefined`.

### B6 — remap must be downward-only, shrunk, monotone, and sample-gated

The remap multiplies directly into notional (`strategy.ts` ~1145 `rawConviction
= confidenceScore/100`). Use `shrunkWinRate` (Bayesian-shrunk via `SHRINK_PRIOR`)
NOT raw `winRate`. Make the remap **only able to reduce** conviction (never
inflate a band above its stated confidence — that stacks two optimisms).
Enforce **monotonicity** across the 4 bands (isotonic clamp) so a low-N mid band
that out-wins the top band by noise cannot invert the confidence ordering.
Sample-gate per band by `minClosedLotsForWeightShift` (fall back to raw below
the gate). `getConfidenceCalibration` filters to `side === 'long'` only — shorts
must fall back to raw conviction, not to an empty/zero band. Apply the remap
**before** `convictionCapUncorroborated` (`types.ts:173`) and compose as a MIN so
the cap still binds. Compute the calibration **once per run** and thread it in
(like the regime/thesis scorecards) — do not call `getConfidenceCalibration`
per-proposal inside the sizing loop.

### B7 — ship the report; if applied, Unknown-regime must fall back to global

`determineMarketRegime` (`macro.ts:270`) yields 5 labels + `'Unknown (no macro
feed)'`. Splitting the audit history 5–6 ways collapses per-regime sample size;
`runWalkForwardOOS` already nulls below 4 dates for the *global* vector, so most
regimes will be null/noise for a long time. Default to the audit's own fallback:
ship the **admin per-regime IC report only**, application OFF. If applied: add
an **optional** parallel field `policy.regimeScoringWeights?:
Partial<Record<MarketRegime, ScoringWeights>>` (do NOT reshape the flat
`policy.scoringWeights`, `types.ts:456`), gate per-regime on that regime's own
closed-lot count, and **always** route the `Unknown` bucket to the global
vector.

### B8 — there is a real exit-side cost bypass; this is NOT test-only

`applyExecutionCost` is applied only in `recordFillFromProposal`
(`performance.ts:183`) for `source === 'paper'` *entries*. Two other writers
insert fills at **raw** price with no cost: `synthetic-stops.ts:272` and
`order-replacement.ts:149` (verified: neither imports `applyExecutionCost`). A
paper lot entered cost-adjusted but **exited via a synthetic stop** pays
slippage on entry and none on exit — asymmetric, and it overstates realized edge
on exactly the stop-loss (losing-tail) exits. That inflates win rates fed to
`getFactorScorecard`, `getConfidenceCalibration`, the thesis scorecard, and the
tuner's `compactPerformance`. **Fix:** apply `applyExecutionCost` with the
**exit side** (sell/cover) to paper/test exits in `synthetic-stops.ts` and
`order-replacement.ts`, then add the round-trip regression test against a
`'paper'` fixture (never `'live'` — live exits reconcile to real price).

---

## New-improvement backlog (prioritized, survived skeptic)

All flags default OFF unless noted; all preserve byte-identical behavior when
unset. Effort: S/M/L.

### P0 — required guardrails before B1 autonomy can be trusted

#### P0-1 — Restrict autonomous-apply to `scoringWeights` only (never risk limits / authority)
- **Flag:** `policy.tuning.autoApplyWeights` (reuses B1's flag; this constrains what it may write).
- **Effort:** S.
- **Spec:** In the new cadence caller, construct the persisted delta from **only**
  `proposal.proposedPatch.scoringWeights` (merge over current →
  `normalizeScoringWeights` → clamp to `MAX_WEIGHT_STEP` post-normalization);
  never read `proposedPatch.policy` or `proposedPatch.prompt` on this path.
  `StrategyTuningPatch` (`types.ts:997`) can carry `strategyAuthority`,
  `maxDailyNotional`, `riskRules`, `sectorCaps` — all ungated by `applyOosGate`.
  Belt-and-suspenders test: a proposal whose `proposedPatch.policy` sets
  `strategyAuthority: 'decide'` or a loosened `maxDailyNotional` must leave
  `getPolicy(userId)` unchanged after an auto-apply cadence run.

#### P0-2 — Effect-size + paired-t significance margin on the OOS gate
- **Flag:** `policy.tuning.minOosICImprovement` (default 0 = today's strict `>`).
- **Effort:** S–M.
- **Spec:** Replace the bare `candidateIC > baselineIC` (`strategy-tuning.ts:325`)
  for the autonomous path with a margin AND a paired significance test. The two
  OOS composite ICs are computed on the **same** test fold and are highly
  correlated, so the difference's SE must come from the **paired per-date
  IC-difference series** — expose the `perDateICs` array (currently computed but
  discarded, `backtest.ts:511,525`; only `{meanIC, icIR}` returned at line 503)
  and require `(candidateIC − baselineIC) > max(minOosICImprovement, k·SE_paired)`.
  A flat margin alone is the minimum; the paired-t is the correct form. Do not
  ship an "escalating min-delta" as a t-stat substitute.

#### P0-3 — Fail-closed tuning-config invariant guard
- **Flag:** gates only the autonomous path under `autoApplyWeights`; the pure validator is always-on/passive.
- **Effort:** S.
- **Spec:** Add a pure `validateTuningInvariants(tuning): { ok, violations }`
  (new `src/lib/tuning-invariants.ts`) checking a **small** set of hard safety
  couplings from `TuningSettings` (`types.ts:153`): sample gates > 0,
  `sizingFloorPct ≤ sizingCeilingPct`, `autoApplyWeights ⇒ oosWithholdUnvalidated
  true` (or an explicit override flag), calibration-into-sizing flag ⇒ a valid
  band gate. Call it at the **top** of the autonomous apply path: on violation,
  **skip** the apply, write an audited "skipped: invariant violation" row,
  surface in the dashboard — **never throw** (a throw would wedge the scheduler
  tick). In the manual tune route, emit violations as warnings, not blocks.

#### P0-4 — Unified learning-mutation ledger + one-click revert
- **Flag:** ledger is passive/always-on (records only when a gated mutation fires); revert route is `requireAdmin`.
- **Effort:** S.
- **Spec:** *(Merges the quant panel's "weight-change ledger" and the
  architecture panel's "single learning-mutation ledger" — they are the same
  capability; do not build two.)* New `src/lib/learning-ledger.ts`:
  `recordLearningMutation({ kind, userId, accountId, before, after, evidence,
  flag })` writes one canonical `audit('learning_mutation', …)` row (subsystem,
  full prior + new `ScoringWeights` vector, OOS readout, sample sizes, flag);
  `revertLastLearningMutation(kind, userId, accountId)` reads the most-recent
  row and re-applies `before` via `setPolicy` **only** (never a bespoke writer —
  keeps `account_strategy_state` and the active-profile mirror in sync). Capture
  `before` atomically (read effective policy immediately before the `setPolicy`
  write) or a concurrent multi-agent write records a stale baseline. Admin-gate
  the revert route (this repo has prior IDOR history) and scope by
  `userId+accountId+subsystem`. B1's apply and any B3 nudge call this instead of
  hand-rolling audit rows.

### P1 — high-leverage safety / soundness

#### P1-1 — Deterministic dry-run (replay) harness for the autonomous decision
- **Flag:** none (read-only, `requireAdmin`); underlying apply stays behind `autoApplyWeights`.
- **Effort:** S.
- **Spec:** Thread `dryRun` through the B1 apply fn:
  `maybeRunAutoTuning(userId, accountId, { dryRun: true })` runs
  `proposeStrategyTuning → applyOosGate → clamp` and returns `{ before, after,
  oosReadout, clampedDeltas, oosICCandidate, oosICBaseline, wouldApply }` with
  **zero writes** — no `setPolicy`, no ledger row, no cadence-key advance
  (assert with spies). Expose behind a read-only `requireAdmin` route mirroring
  the `backtest-ic` "suggestion only" pattern. This is both the safe operator
  on-ramp ("inspect the decision before enabling") and B1's unit-test surface.
  Land before any real auto-apply.

#### P1-2 — Purged & embargoed walk-forward split
- **Flag:** `policy.tuning.oosPurgeEmbargo` (default off = current single-split byte-identical).
- **Effort:** M.
- **Spec:** The single chronological 70/30 split in `runWalkForwardOOS`
  (`backtest.ts` ~646/651) leaks: train observations whose forward-return window
  `[date, date+horizonDays]` straddles the boundary share realized bars with the
  first test observations, inflating OOS IC — the exact metric B1 turns into an
  actuator. Add a default-off option to `splitWalkForward` that (1) **purges**
  train rows whose forward window overlaps the first test date and (2)
  **embargoes** `horizonDays` worth of snapshot-date buckets after the boundary.
  Apply the embargo in unique-snapshot-date terms, not calendar days. Fails safe:
  purging shrinks samples → more `null` returns → gate strips weights. Keep
  K-fold as a *separate later* flag, not part of this change. Gate B1's
  auto-apply on the purged metric.

#### P1-3 — Auto-tuning shadow / forward-A-B ledger (forward validation before trust)
- **Flag:** `policy.tuning.shadowWeightLedger` (default off).
- **Effort:** L.
- **Spec:** Per run, compute the composite under BOTH active (possibly
  auto-tuned) and frozen human-baseline weights, and record both rankings +
  realized forward outcomes to the audit log (a compact per-run summary, not
  per-candidate rows). Surface a rolling forward-IC/return comparison in the
  dashboard, **flagged low-power below a documented sample floor**. Overlapping
  forward-return windows autocorrelate the ledger IC, so any "auto underperforms
  baseline" test needs the same overlap-aware SE as P0-2. Only after the floor
  is met may it act as a hard gate on B1 auto-apply. Reuses `scoreFactors` +
  `signal_snapshot`; strictly off the sizing/order path.

#### P1-4 — Survivorship & look-ahead certification (split hard vs soft)
- **Flag:** none (diagnostic/test-only; gates nothing on the money path).
- **Effort:** M.
- **Spec:** Two deliverables, kept separate. (a) **HARD leakage unit test** — a
  CI-failing assertion that forward returns use the close of a bar strictly
  *after* the snapshot date at exactly `horizonDays` offset (via
  `buildFactorObservations` + the OHLC fetcher). (b) **SOFT admin diagnostic** —
  report the fraction of snapshotted symbols with a resolvable forward price
  (survivorship proxy), explicitly labeled a proxy that does **not** certify
  absence of survivorship bias (the `signal_snapshot` log may itself be
  survivor-only) and gates nothing. Keep both off the per-scan path.

#### P1-5 — Confidence-calibration remap: monotone + low-N shrunk (companion to B6)
- **Flag:** `policy.tuning.calibratedSizing` (same flag as B6; default off).
- **Effort:** S.
- **Spec:** Hardens B6's acceptance. Beyond "poorly-calibrated high band is
  sized down", require the mapping to (a) read `shrunkWinRate` not raw
  `winRate`, and (b) enforce a **monotone non-decreasing** multiplier across the
  4 bands (cumulative-max isotonic clamp) so a low-N `70–84` band that
  out-performs `85–100` by chance can never size a lower-confidence proposal
  larger than a higher-confidence one. Below the per-band sample floor, use
  identity (raw confidence). Unit-test the crossover case explicitly.

### P2 — improve honesty of learner inputs (lower blast radius)

#### P2-1 — Missed-opportunity hit-rate (track skipped LOSERS, not just winners)
- **Flag:** `policy.tuning.missedOpportunityRequireHitRate` (default off); sequence **after** B4.
- **Effort:** S.
- **Spec:** `summarizeMissedOpportunities` counts only winners (`returnPct > 0`,
  `strategy-tuning.ts:109`), discarding the denominator — a factor that "recurs"
  among winners may just be the most *common* skipped factor. `getSkippedCandidateReturns`
  already returns ALL matured skipped candidates; keep the pure summarizer pure
  but, before slicing, tally per-factor total and per-factor **benchmark-beating**
  (B4's excess-return) winners, compute a hit rate **shrunk toward the overall
  skipped hit rate** (not a bare 55%), and only set `recurringFactor` when count
  ≥ threshold AND shrunk hit rate ≥ the base rate AND a minimum denominator.
  Blast radius is small (feeds only tuner context + Bull prompt, never
  `scoreFactors`) — do not over-engineer.

#### P2-2 — Benchmark-basis parity for skipped losers (companion to P2-1 / B4)
- **Flag:** same flag as the B3 nudge / P2-1.
- **Effort:** S.
- **Spec:** Define one `excessReturn(return, spy)` helper (SPY over the matched
  per-row horizon via `buildSpyReturnMap`) and apply it **identically** to the
  winner and loser classification, so the net per-factor signal is
  net-of-benchmark on both sides. A name beating zero but lagging SPY is neither
  a winner nor an "avoided loss". Reuse the existing SPY util; do not add a
  second fetcher.

#### P2-3 — Signed / directional top-bucket gate for the congress signal (companion to B2)
- **Flag:** `policy.tuning.congressRequireTopBucketPositive` (default off); inert until B2 wires the eval.
- **Effort:** S.
- **Spec:** The money path is long-biased, but `evaluateCongressScore` can pass
  on a symmetric top-minus-bottom spread whose edge lives entirely in the short
  leg. Require the **top quantile's own EXCESS return** (over the
  cross-sectional/date mean or SPY — not raw `avgReturn`, which is near-vacuous
  in a bull tape) to be positive, and `top.n ≥ minTopBucketObservations`, before
  congress may **promote** a below-cutoff name into the candidate set. Below the
  n floor, fall back to current behavior (never suppress the existing signal on
  thin data). Reuses the already-computed `quantiles[].avgReturn/.hitRate`.

#### P2-4 — Shrink IC-derived weights toward the prior (allocation-variance control)
- **Flag:** `policy.tuning.icWeightShrinkage` (default λ=0 = current behavior).
- **Effort:** M.
- **Spec:** `deriveWeightsFromICs` (`backtest.ts:237`) floors negative ICs at 0
  and normalizes raw positive ICs — no shrinkage toward `DEFAULT_SCORING_WEIGHTS`
  by estimator noise, so a single high-IC factor on a thin train fold gets a
  disproportionate weight. Add optional shrinkage `w_final = λ·w_IC +
  (1−λ)·w_default` with λ driven by evidence strength (per-factor n or composite
  ICIR). This acts on allocation **magnitude** and composes with — does not
  duplicate — P1-2 (which certifies the gate). Apply shrinkage **before** the
  `MAX_WEIGHT_STEP` clamp. Keep the unshrunk vector as the report-path pre-image.

#### P2-5 — Turnover / drawdown guardrail on autonomous applies
- **Flag:** `policy.tuning.autoApplyDrawdownGuard` (default off; only meaningful with `autoApplyWeights`).
- **Effort:** M.
- **Spec:** *(Skeptic correction: this is more than "a second curve".)*
  `runWalkForwardOOS` builds exactly ONE equity curve, from the data-derived
  `icWeights` (`backtest.ts:659,680`); `maxDrawdownPct` is off that curve, not
  from `candidateWeights`/`baselineWeights` (which only feed `.meanIC`, lines
  665–668). Gating candidate-vs-baseline drawdown requires building **two new**
  equity curves (candidate top-K, baseline top-K) under identical
  top-K/cost/tax/SPY inputs. In the autonomous path, refuse to persist if
  candidate OOS `maxDrawdownPct` exceeds baseline beyond a tolerance — but
  **only** when `testDates ≥` a minimum floor (below it, fall back to the IC
  gate). Sharpe delta is advisory/audited, not a hard block (tiny-sample Sharpe
  on overlapping-horizon returns is badly biased).

#### P2-6 — Fixed-window OOS starvation guard (test-date floor)
- **Flag:** date-floor gate under `autoApplyWeights`; the report is always-on.
- **Effort:** M.
- **Spec:** `buildFactorObservations` reads the most-recent
  `DEFAULT_AUDIT_LIMIT=500` rows; as candidates-per-scan grows, 500 rows spans
  fewer distinct dates, silently collapsing the 70/30 OOS test fold. Decouple the
  OOS observation window from the 500-row cap (raise/parametrize the OOS-path
  audit limit, or page `signal_snapshot` to guarantee a minimum distinct-date
  count), stamp the actual `(trainDates, testDates)` into the apply audit row,
  and refuse auto-apply below a configurable `minOosTestDates` (distinct from the
  existing `<4` hard-null). Cap the read and reuse the per-symbol bar cache.

#### P2-7 — Reproducibility / decision-provenance snapshot per apply
- **Flag:** none (always recorded when an apply fires under `autoApplyWeights`).
- **Effort:** S.
- **Spec:** `runWalkForwardOOS` is IO + time-dependent (`fetchDailyOHLC(now)`),
  so a later re-run cannot reproduce the fold that justified an apply. On each
  autonomous apply, write `audit('tuning_apply_provenance', …)` with observation
  count, distinct train/test dates, split index, `candidateIC`, `baselineIC`,
  ICIR, margin used, flags in effect, and the scanned audit-row id range.
  Companion to P0-4 (what changed) and P1-1 (what would change).

#### P2-8 — Congress go/no-go: scheduled, cached, test-fixtured (companion to B2)
- **Flag:** `policy.tuning.congressGoNoGoGate` (default off).
- **Effort:** M.
- **Spec:** B2 under-specifies the hard parts. Add a cadence job that computes
  `evaluateCongressScore` from `buildCongressScoreObservations`, persists
  `{ verdict, stats, computedAt }` to settings, and a **recorded-observation
  JSON fixture** + vitest asserting (1) a passing verdict leaves the congress
  contribution intact and (2) a no-go-on-significance verdict drops a name lifted
  only by congress. `market.ts` reads the cached verdict cheaply (never calls the
  eval inline). Pass a fixed `placeboSeed` so the placebo check always fires.
  Surface `{ verdict, reasons, asOf }` (and `benchmarkCoveragePct`) in the
  dashboard; a missing/stale verdict fails **open** to current behavior.

### Deferred (sequence last)

#### D-1 — Multiplicity-aware (deflated) significance on repeated auto-applies
- **Fold into P0-2, not standalone.** Persist a per-account trial counter
  (increment on each auto-apply evaluation, reset on any human `setPolicy` of
  weights) and require the paired-t (P0-2) to clear a Šidák-adjusted critical
  value for the trial count. No teeth until B1 auto-apply exists and P0-2's
  paired-t is built.

#### D-2 — Auto-revert / kill-switch on realized post-apply degradation
- **Phase 1 = ALERT-ONLY.** Tag closed lots with the applied weight-vector audit
  id; each cadence, compare shrunk realized edge of ≥20 lots under the new vector
  vs baseline; on degradation, raise an audited dashboard alert + notify, require
  **human** confirmation to revert. Phase 2 (default-off, admin-only,
  rate-limited, suppressed during regime change) may auto-invoke the P0-4 revert.
  Depends on B1 + P0-4 + lot-level version tagging (new persistence). Document
  detection latency.

#### D-3 — Scheduled re-validation + decay-to-prior of a live vector; staged canary ramp
- **After D-2.** Re-run OOS on the currently-live vector vs baseline each cadence;
  after K consecutive failing checks, decay one clamped `MAX_WEIGHT_STEP` toward
  `DEFAULT_SCORING_WEIGHTS` (graceful unwind, not a snap-revert). Separately, a
  ramp schedule (`weightApplyRampSteps`, default 1 = today's immediate full
  apply) applies a fraction of the delta and advances only after a healthy hold
  window. Both default-off; both bound the gap between shadow (P1-3) and the
  kill-switch (D-2).

#### Dropped
- The `lens=test` placeholder item (`t`/`pr`/`ra`) — non-substantive, no content.

---

## Cross-file traps

- **`deriveWeightsFromIC` / `deriveWeightsFromICs` / `runWalkForwardOOS` live in
  `backtest.ts`, not `strategy-tuning.ts`.** `strategy-tuning.ts` only *imports*
  `runWalkForwardOOS`. OOS-harness work (P1-2, P2-5, P2-6, P2-4) edits
  `backtest.ts`.
- **`computeCompositeIC` already computes `perDateICs` (`backtest.ts:511`) but
  returns only `{meanIC, icIR}` (line 503).** P0-2's paired-t needs that array
  (or its std) exposed — it is not currently on the return type.
- **Two SPY sources must not multiply.** Only reuse `buildSpyReturnMap` /
  `fetchDailyOHLC('SPY')` from `backtest.ts`; do not add a SPY fetch in
  `strategy-tuning.ts` (zero SPY references there today).
- **`congress-score.ts` ≠ `congress-score-eval.ts`.** `market.ts` uses
  `scoreCongressSignal` from the former (wired into scan); the latter is the
  statistical validator (zero production importers). B2/P2-3/P2-8 wire only via
  a cached verdict — do not merge the files.
- **`policy.scoringWeights` has two write paths.** `pickAccountFields` /
  `writeAccountStrategyState` (account table) AND the active-profile mirror. Any
  weight write MUST go through `setPolicy` (`db-profiles.ts:412`) so
  `mirrorPolicyToActiveAccount` keeps them in sync. Bespoke writers desync the
  dashboard from scoring.
- **`Unknown (no macro feed)` regime is not a market state.** Any per-regime
  scheme (B7) must hard-fall-back to the global vector for it.
- **Test/paper both tag `source === 'paper'`; live is separate.** B8/its tests
  assert against a `'paper'` fixture; live exits reconcile to real price and must
  never be cost-adjusted.

## Verification / test guidance

Standard gate (in order): `npx tsc --noEmit` → `npm test` → `npm run build` →
`npm run lint`. Tests use a temp SQLite file per run (`DATABASE_URL=file:<tmpdir>/…`)
— never point at `data/app.db`. Per-item acceptance:

- **P0-1:** proposal with `proposedPatch.policy.strategyAuthority='decide'` +
  loosened `maxDailyNotional` → `getPolicy` unchanged after an auto-apply run.
- **P0-2:** a 0.0001 IC improvement is rejected under a nonzero margin, accepted
  under margin=0; paired-t uses the per-date difference series.
- **P0-3:** `autoApplyWeights=true` with `oosWithholdUnvalidated=false` (no
  override) → apply skipped, invariant-violation audit row, no throw.
- **P0-4:** after an apply, the ledger row carries the full prior vector; revert
  restores it deep-equal via `setPolicy` (both account row and active-profile
  mirror agree); revert route rejects non-admin.
- **P1-1:** `dryRun:true` performs zero writes (spies on `setPolicy` + ledger +
  cadence-key), returns the correct `wouldApply` decision.
- **P1-2:** purge removes a train row whose forward window straddles the
  boundary; flag-off is byte-identical.
- **P1-4:** forward-return window never includes the snapshot day (CI-failing);
  survivorship coverage renders as a labeled proxy, gates nothing.
- **P1-5 / B6:** non-monotone synthetic curve does not invert conviction
  ordering; short/undefined-confidence falls back to raw, never 0; flag-off
  sizing byte-identical.
- **B8 / P2-2:** paper round-trip (buy entry + synthetic-stop sell exit) reflects
  cost on **both** legs; a gross-marginal winner becomes net-flat/loser;
  `source='live'` exit is never adjusted; `PAPER_EXECUTION_COST_MODEL=off` books
  raw on all paper writers.
- **B2 / P2-8:** flag-off byte-identical regardless of verdict; FAIL-on-significance
  drops a congress-only name; INSUFFICIENT-data falls back to current; verdict is
  read from cache in-scan (spy asserts the eval fn is not invoked).

## Open decisions

- **B1 default cadence** for `maybeRunAutoTuning` (daily vs every-N-strategy-runs)
  and whether it is per-account or per-user.
- **P0-2 margin defaults** (`minOosICImprovement`, `k`, `oosICIR` floor,
  `minOosTestDates`) — pick conservative starting values; document that too-strict
  values silently no-op autonomy (must be surfaced/audited, not silent).
- **B7 application:** ship report-only, or attempt gated per-regime application?
  Recommendation: report-only until per-regime closed-lot counts are demonstrably
  large.
- **B3 route:** Bull-prompt-context (recommended first cut) vs a `scoreFactors`
  nudge routed through the B1 OOS/clamp/ledger pipeline. Never a raw additive
  `scoreFactors` mutation (two-writer conflict with B1).
- **D-2 autonomy:** does the kill-switch ever auto-revert, or stay alert-only?

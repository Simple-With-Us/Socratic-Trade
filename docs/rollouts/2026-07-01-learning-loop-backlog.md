# 2026-07-01 — Learning-loop broader backlog (P1 + P2), backend/API/tests only

Branch: `agent/claude-backlog-b-learning-b` (off `origin/main` after #300 merged).
Base: #296 (Workstream B autonomous factor-weight tuning) + #300 (follow-on B: unified
`learning_mutations` ledger, `tuning-invariants.ts`, `pairedICDiffStats`).
Design source: `docs/reviews/2026-07-01-learning-loop-expansion.md`.

## Summary

Implemented the remaining P1 + P2 backlog from the expansion doc, building ON #300's helpers
(the ledger, the fail-closed invariant validator, and the paired-t OOS helper) rather than
duplicating them. BACKEND / API / TESTS ONLY — no `app/` UI component was edited (the dashboard
redesign is owned by a parallel chat thread), and the "admin ledger UI" item was skipped per that
constraint (the #300 ledger route is API-only). `red-team.ts` / inline-Bear were not touched
(separate session owns Red Team). Every behavior-changing knob defaults OFF / no-op with a per-flag
byte-identical proof.

## Why

The through-line of the expansion doc: #296 turned the tuner into the first autonomous writer of
`policy.scoringWeights`, and #300 added the P0 guardrails (ledger, paired-t, fail-closed config).
This pass adds the P1 safety/soundness on-ramps (a read-only dry-run, leakage-free validation,
forward-shadow validation, look-ahead certification) and the P2 learner-input honesty items
(hit-rate over losers, benchmark parity, a directional congress gate, IC shrinkage, drawdown /
starvation guards, decision provenance, a scheduled/cached congress refresher).

## Items completed

- **P1-1** deterministic dry-run/replay. Refactored the autonomous gate into a shared,
  side-effect-free `evaluateAutonomousWeightTuning()`; added `dryRunAutonomousWeightTuning()`
  (ignores `autoApplyWeights`, ZERO writes) + admin route `GET /api/admin/tuning-dry-run`
  (`requireAdmin`). Returns `{ wouldApply, before, after, clampedDeltas, oosICCandidate/Baseline,
  oosReadout, invariantViolations }`.
- **P1-2** purged & embargoed split. `splitWalkForward` gained opt-in `{ purge }`; `runWalkForwardOOS`
  gained `purgeEmbargo` (from `policy.tuning.oosPurgeEmbargo`). Purge drops the last `horizonDays`
  train-date buckets that straddle the boundary. Embargo already existed; default-off = byte-identical.
- **P1-3** shadow / forward-A/B ledger. `policy.tuning.shadowWeightLedger` records a passive shadow
  row (trigger `auto_weight_shadow`) in #300's `learning_mutations`, capturing the would-be apply +
  OOS readout WITHOUT touching policy. Independent of `autoApplyWeights`; a distinct trigger keeps
  revert from ever restoring a shadow.
- **P1-4** survivorship & look-ahead certification. HARD `isPointInTimeForwardExit()` (pure) + a
  CI-failing unit test; SOFT `certifyForwardResolution()` (IO) forward-coverage proxy + point-in-time
  check, labeled a proxy that gates nothing.
- **P2-1 / P2-2** missed-opportunity hit-rate. `summarizeMissedOpportunities` gained `requireHitRate`
  (+`minHitRateDenominator`, `hitRateShrinkPrior`): flags a factor only when its benchmark-beating hit
  rate over ALL matured skipped rows (winners+losers), shrunk toward the overall skipped base rate,
  clears that base rate with a min denominator. Same benchmark-relative test classifies both legs.
  `proposeStrategyTuning` widens the skipped fetch to 100 when on. Flag
  `policy.tuning.missedOpportunityRequireHitRate`.
- **P2-3** signed/directional top-bucket congress gate. `evaluateCongressScore` gained
  `requireTopBucketPositive`: requires the top bucket's own excess return positive + a min-n floor.
  Wired via `policy.tuning.congressRequireTopBucketPositive` in the eval route + the P2-8 refresher.
- **P2-4** IC-weight shrinkage. `deriveWeightsFromICs(ics, fallback, λ)` blends toward
  `DEFAULT_SCORING_WEIGHTS`; `runWalkForwardOOS` reads `policy.tuning.icWeightShrinkage` (default 0).
- **P2-5** drawdown guard. `runWalkForwardOOS` returns `candidate/baselineMaxDrawdownPct` (two extra
  equity curves via pure `maxDrawdownOfCurve`); the autonomous gate blocks a >2pt DD spike when
  `testDates ≥ 8`. Flag `policy.tuning.autoApplyDrawdownGuard`.
- **P2-6** OOS starvation floor. `policy.tuning.minOosTestDates` raises the distinct-test-date floor
  above the `AUTO_TUNE_MIN_TEST_DATES` env default.
- **P2-7** provenance. Each real apply writes `audit('tuning_apply_provenance', …)` (fold shape,
  ICs/ICIR/paired-t, drawdowns, thresholds, flags in effect).
- **P2-8** congress go/no-go scheduled + cached + fixtured. New `refreshCongressScoreVerdict()`
  cadence-callable refresher (moves the eval off the scan hot path; read-time cache already existed);
  honors P2-3. Fixtured vitest (recorded snapshots + injected OHLC fetcher + fixed `placeboSeed`).
- **Composed paired-t gate E2E** (#300 deferred): DB-backed test seeds closed lots + mocks
  `runWalkForwardOOS` to exercise the full `applyAutonomousWeightTuning` gate boolean.

## Items deferred / skipped (with reasons)

- **D-1 multiplicity-aware significance** — DEFERRED (documented in code + phase doc). Needs a
  per-account trial counter and has no teeth until the paired-t (P0-2) is on; a single-shot
  Šidák/Bonferroni bolt-on would be noise today.
- **P1-5 calibration remap** — verified ALREADY shipped in #296 (`calibratedConviction`: downward-only,
  isotonic-monotone via `poolAdjacentViolators`, `shrunkWinRate`, per-band sample gate, short/undefined
  fall back to raw). Skipped as instructed.
- **Admin ledger UI** — skipped: the #300 ledger route is API-only and UI is owned by the parallel
  dashboard-redesign thread.

## Files

New:
- `app/api/admin/tuning-dry-run/route.ts` (P1-1 read-only admin route)
- `test/learning-loop-backlog.test.ts` (P1-1/P1-3/P2-5/P2-6 + composed paired-t E2E, DB-backed)
- `docs/rollouts/2026-07-01-learning-loop-backlog.md` (this note)

Changed:
- `src/lib/types.ts` — 7 new `TuningSettings` flags (all default off/no-op).
- `src/lib/backtest.ts` — `splitWalkForward` purge; `deriveWeightsFromICs` shrinkage; `runWalkForwardOOS`
  `purgeEmbargo`/`icWeightShrinkage`/candidate+baseline drawdown; `maxDrawdownOfCurve`;
  `isPointInTimeForwardExit` + `certifyForwardResolution`; `OOSResult`/`OOSRunOptions`/
  `SplitWalkForwardOptions` interfaces.
- `src/lib/strategy-tuning.ts` — shared `evaluateAutonomousWeightTuning`; `dryRunAutonomousWeightTuning`;
  shadow ledger; P2-5/P2-6 gate; `tuning_apply_provenance`; `summarizeMissedOpportunities` hit-rate gate
  + fetch widening; new exported constants/interfaces.
- `src/lib/congress-score-eval.ts` — `requireTopBucketPositive` option + reason.
- `src/lib/congress-score-gate.ts` — `refreshCongressScoreVerdict()`.
- `app/api/admin/congress-score-eval/route.ts` — honor `congressRequireTopBucketPositive`.
- `test/backtest.test.ts` — purge / shrinkage / drawdown / point-in-time pure tests.
- `test/strategy-tuning-missed-opps.test.ts` — hit-rate + benchmark-parity tests.
- `test/congress-score.test.ts` — top-bucket gate tests.
- `test/learning-loop-autotuning-db.test.ts` — P2-8 refresher tests.
- `STATUS.md`, `PLAN.md`, `docs/phase-7-strategy.md` (§3.E.8–E.15).

## Verification (all run, in order)

- `npx tsc --noEmit` — clean (exit 0).
- `npm run lint` — 0 errors, 276 grandfathered warnings.
- `npm test` — 195 files / 1977 tests pass (was 193/1918 at #302; +2 files, +59 tests).
- `npm run build` — Compiled successfully; `/api/admin/tuning-dry-run` route registered.

## #300 reconciliation

Built directly on #300's exports — reused `recordLearningMutation` / `LEARNING_SUBSYSTEM_SCORING_WEIGHTS`
(P1-3 shadow, distinct trigger so it never collides with the revert path), `pairedICDiffStats` /
`OOSResult.pairedICDiff` (the composed E2E asserts the gate boolean #300 left untested), and
`validateTuningInvariants` (surfaced in the P1-1 dry-run). No #300 behavior changed; the autonomous gate
was refactored into a shared evaluator that the existing apply path and the new dry-run both call, so the
real-apply behavior is preserved (all prior `learning-loop-*` tests still pass).

## Follow-ups / risks

- The P2-5 drawdown guard builds two extra OOS equity curves per apply (only on the autonomous path,
  gated behind its default-off flag) — negligible cost, but noted for the record.
- D-1 multiplicity remains the main open safety item once operators start turning on the paired-t at
  scale (repeated auto-apply trials inflate false-positive rate). Ship the per-account trial counter next.
- A scheduler hook that periodically calls `refreshCongressScoreVerdict` / (future) `applyAutonomousWeight-
  Tuning` on a slow cadence is still the natural next wiring (the functions are cadence-callable; the
  scheduler cron is not added here to keep this pass API/lib-only).

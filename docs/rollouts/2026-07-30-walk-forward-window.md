# 2026-07-30 — qlib Walk-Forward Window Report + In-Sample Disclosure — KIMI

## Context & Objective

Owner-directed OSS-lessons program (`docs/oss-lessons.md`). This is **§6 slice 3 of 3** (qlib
walk-forward discipline for auto-tune windows; slice 1 — Jesse rule significance — landed in
PR #2294; slice 2 — TraderHarness PIT masking — remains planned, see follow-up below). The task:
confirm the auto-tuner's tuning windows never include the evaluation window, and add a
walk-forward report when they do.

## Changes Made

**Audit finding.** The walk-forward *split* itself is sound: chronological unique-date split,
always-on test-side embargo (`horizonDays` date-buckets — surviving test dates share no realized
bars with the train tail), opt-in train-side purge (P1-2, `policy.tuning.oosPurgeEmbargo`, already
wired into the autonomous path). The genuine residual leak is upstream of the split: the tuner's
candidate weights are proposed by `proposeStrategyTuning` from evidence drawn from ALL history —
closed-lot outcomes, factor/source scorecards, skipped-candidate counterfactuals — which includes
the recent held-out OOS test fold. The candidate-vs-baseline comparison the gates make is
therefore **partially in-sample** — precisely the "tuning window includes the evaluation window"
trap qlib's walk-forward discipline exists to catch.

**Implementation (report + disclose):**

- `src/lib/backtest.ts` — `splitWalkForward` now also returns exact fold-boundary indices
  (`WalkForwardBoundary`: `totalDates`/`cutIdx`/`trainCutIdx`/`testCutIdx`; destructuring callers
  unaffected). `OOSResult` gains a required `window: OOSWindowReport` (train/test first+last dates,
  embargoed + purged date counts) computed straight from the boundary. New pure `formatOosWindow`
  one-clause renderer.
- `src/lib/strategy-tuning.ts` — the manual `applyOosGate` readout now names the exact held-out
  window and carries the partially-in-sample disclosure in BOTH the withhold and validated caution
  branches. The autonomous `oosReadout` (flows into the learning-ledger row and the P2-7
  provenance audit) gains the window report + `PARTIALLY_IN_SAMPLE_CAVEAT`;
  `AutonomousWeightDecision` type extended.
- `test/backtest.test.ts` — boundary report tests (embargo-only indices, purge indices, embargo
  cap) + `formatOosWindow` rendering test.
- `test/strategy-tuning.test.ts` — the OOS-IMPROVE caution now asserts the exact window clause and
  the disclosure; `OOSResult` fixtures (this file + `test/learning-loop-backlog.test.ts`) gained
  the required `window` field.
- Docs: this note, `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/oss-lessons.md` §6/§9.

## Decisions & Trade-offs

- **Report + disclose now; time-bounded evidence filed as follow-up.** The definitive fix — cutting
  every proposal-evidence query off at the test-fold start date — touches each scorecard/fills/
  counterfactual call in `proposeStrategyTuning` and changes what the LLM is allowed to see. It is
  filed on the effort board (PLANNED / UNASSIGNED) rather than bundled here. Until it lands, every
  OOS decision record carries the honest caveat: a pass is necessary, not sufficient, evidence of
  an edge.
- **Purge stays opt-in.** With the always-on embargo equal to `horizonDays`, surviving test dates
  already share no bars with the train tail; the purge is defense-in-depth for non-daily snapshot
  cadences, not a correctness gap. Not flipped by default — byte-identical default behavior is a
  repo convention for these panels.
- `window` is a REQUIRED `OOSResult` field (not optional) so no future consumer can silently drop
  the disclosure; the three test fixtures that construct `OOSResult` literals were updated.
- No new audit event: the window + caveat ride the existing ledger/provenance payload, which is
  the right evidence surface.

## Verification State

```
npx tsc --noEmit                                            # clean
npx eslint src/lib/backtest.ts src/lib/strategy-tuning.ts test/backtest.test.ts \
  test/strategy-tuning.test.ts test/learning-loop-backlog.test.ts
                                                            # 0 errors, 7 warnings (pre-existing)
npx vitest run test/backtest.test.ts test/strategy-tuning.test.ts \
  test/learning-loop-backlog.test.ts test/coarse-credit.test.ts --maxWorkers=4
                                                            # 89/89 passed
npx vitest run --shard=1/3 --maxWorkers=8                   # 1856/1856 passed
npx vitest run --shard=2/3 --maxWorkers=8                   # 1764/1764 passed
npx vitest run --shard=3/3 --maxWorkers=8                   # 1830/1830 passed
npm run build                                               # clean
```

Build passes; full suite 5450/5450 across 472 test files (3 shards).

## Next Steps & Blockers

- PR #2305 — auto-merge armed; merge == auto-deploy (2026-07-10 protocol).
- Follow-up filed on the effort board: **time-bounded proposal evidence** — cut
  `proposeStrategyTuning`'s evidence queries (scorecards, fills, skipped-candidate counterfactuals,
  performance summary) off at the OOS test-fold start so the candidate is generated without seeing
  evaluation-period outcomes; then the "partially in-sample" caveat can be retired for the
  weight path. PLANNED / UNASSIGNED.
- §6 slice 2 (TraderHarness point-in-time masking / entity anonymization for LLM-in-the-loop
  historical evaluation) remains PLANNED / UNASSIGNED and becomes load-bearing the day anyone
  builds an LLM backtest harness.

## Zero-Code Findings

The split-level audit itself was zero-code: embargo + optional purge already implement textbook
purged-and-embargoed walk-forward at the fold level; the leak was at the evidence level, which the
report now discloses on every decision.

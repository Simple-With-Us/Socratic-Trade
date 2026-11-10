# 2026-08-01 — Time-Bounded (PIT) Proposal Evidence for the Auto-Tuner — KIMI

## Context & Objective

Owner-directed follow-up to the §6 slice-3 finding (`docs/rollouts/2026-07-30-walk-forward-window.md`,
PR #2305). That audit found the walk-forward *split* sound but flagged that the auto-tuner's
candidate weights were proposed from ALL-history realized outcomes — including the recent held-out
OOS test fold — making the candidate-vs-baseline comparison **partially in-sample**. Slice 3 shipped
the disclosure; this change is the definitive fix for the weight path: the tuner's realized-outcome
evidence is now cut off at the fold's start date, and the caveat is retired for that path.

## Changes Made

- `src/lib/backtest.ts` — `computeOosEvidenceCutoff`: IO-lite (audit read only, **no OHLC fetches**)
  replication of the walk-forward fold arithmetic (same defaults as `runWalkForwardOOS`: horizon 5,
  audit limit 500, trainFraction 0.7, embargo = horizon date-buckets) over MATURED `signal_snapshot`
  dates. Returns `{ cutoffDate, trainEndDate, totalDates }` or undefined when no surviving fold
  exists (< 4 matured dates, or the embargo swallows the tail) — in which case there is nothing to
  leak into and no cutoff is applied.
- `src/lib/strategy-tuning.ts` — `proposeStrategyTuning` computes the cutoff
  (`policy.tuning.pitEvidenceCutoff`, **default ON**, best-effort try/catch) and threads it through
  every realized-outcome evidence channel: performance summary (prefetched, filtered fills), recent
  fills (over-fetch then filter then slice), factor scorecard, source-value scorecard, and
  skipped-candidate counterfactuals. Stamps `StrategyTuningProposal.evidenceCutoffDate`, discloses
  the cutoff to the reviewer LLM in the evidence context, and `applyOosGate` swaps the
  "partially in-sample" sentence for the cutoff disclosure ("genuinely out-of-sample for the weight
  path"). The autonomous `oosReadout` (ledger + provenance evidence) carries `evidenceCutoffDate`
  when set and the caveat when not; `AutonomousWeightDecision` type extended (both levels).
- `src/lib/performance.ts` — `getFactorScorecard` / `getSourceValueScorecard` gain `closedBefore`
  (closed lots by `exitAt < cutoff`, lots without `exitAt` excluded as unproven; counterfactual
  rows by `exitDate < cutoff` — truly PIT, the return window ENDED before the fold);
  `getSkippedCandidateReturns` gains `maturedBefore`. All default-preserving when unset.
- `src/lib/types.ts` — `TuningPolicy.pitEvidenceCutoff` (default true) and
  `StrategyTuningProposal.evidenceCutoffDate`.
- `test/pit-evidence.test.ts` (NEW, 4 tests) — fold math vs the 20-date June fixture, unmatured-date
  exclusion, embargo tail-swallow, `closedBefore` scorecard filter.
- `test/strategy-tuning.test.ts` — caveat-swap integration test (dedicated userId so the seeded
  snapshot history cannot leak into other tests): asserts the proposal is stamped and the caution
  carries "PIT evidence cutoff 2026-06-26" INSTEAD of "Partially in-sample".
- Docs: this note, `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/oss-lessons.md` §6.

## Decisions & Trade-offs

- **Default ON, not flag-gated off.** The flag exists (`pitEvidenceCutoff: false` restores legacy
  all-history evidence), but the default is the honest validation. Behavior is unchanged whenever
  snapshot history is insufficient for a fold — which is also exactly when there is nothing to leak.
- **Evidence freshness trade-off (documented):** the tuner now learns from ~the train window only.
  The fold rolls forward with new snapshots, so yesterday's held-out outcomes become tomorrow's
  training evidence on the next cadence tick — freshness loss is bounded by the fold geometry, not
  permanent.
- **Cutoff computation is an approximation of the actual fold** (maturity-filtered snapshot dates
  vs per-symbol-resolved observation dates) and is documented as such in the helper; for an evidence
  filter the bias is acceptable, and less-recent evidence is the safe side.
- **Aggregate learning state is NOT cut** (learned lessons, reflection summaries, regime scorecards,
  `getClosedLotCount` sample gate): those are the learning brain's standing state, and masking them
  point-in-time is §6 slice-2 (TraderHarness) territory. The "partially in-sample" caveat stays
  whenever the cutoff is absent (flag off or no fold).
- **`userId`-dedicated integration test** after discovering the shared-DB test file would let seeded
  snapshot history leak across tests.

## Verification State

```
npx tsc --noEmit                                        # clean
npx eslint src/lib/backtest.ts src/lib/strategy-tuning.ts src/lib/performance.ts \
  src/lib/types.ts test/pit-evidence.test.ts test/strategy-tuning.test.ts
                                                        # 0 errors, 8 warnings (pre-existing pattern)
npx vitest run test/pit-evidence.test.ts test/strategy-tuning.test.ts test/backtest.test.ts \
  test/learning-loop-backlog.test.ts test/coarse-credit.test.ts test/post-mortem.test.ts \
  test/performance.test.ts test/significance.test.ts    # 154/154 passed
npx vitest run --shard=1/3 --maxWorkers=8               # 1892/1892 passed
npx vitest run --shard=2/3 --maxWorkers=8               # 1774/1774 passed
npx vitest run --shard=3/3 --maxWorkers=8               # 1872/1872 passed
```

⚠️ Local `npm run build` was BLOCKED by a foreign session's staged-but-uncommitted r2-usage WIP in
this shared worktree (`node:fs` pulled into the client webpack chain via `scheduler.ts` — unrelated
to this diff; their files were never included in this PR's commits — a bare `git commit` initially
swept them up and was immediately corrected via `git reset --soft` + pathspec commit). The build
gate is delegated to verify CI on the clean merge ref (their WIP is not committed anywhere in this
PR's ancestry). Full suite otherwise green: 5538/5538 across 3 shards.

## Next Steps & Blockers

- PR #2327 — auto-merge armed; merge == auto-deploy (2026-07-10 protocol).
- §6 slice 2 (TraderHarness point-in-time masking / entity anonymization for LLM-in-the-loop
  historical evaluation) remains PLANNED / UNASSIGNED — it now also owns the "cut the aggregate
  learning state" question if an LLM backtest harness is ever built.
- The other Kimi session's r2-usage work (staged in this worktree) breaks the local client build
  until it lands — coordinate cleanup via the effort board, not by touching their files.

## Zero-Code Findings

None — this is the code follow-up to slice 3's zero-code split-level audit finding.

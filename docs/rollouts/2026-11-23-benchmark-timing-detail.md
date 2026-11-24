# 2026-11-23: timing-unknown benchmark names its evidence

## Context & Objective
The Tradier sandbox vs SPY card reads unavailable. The audit row from #5456 will name the reason; for snapshot-timing-unknown the reason code alone does not say why the window collapsed. Goal: print the evidence so the real cause is read, not guessed. Nothing is estimated.

## Changes Made
- benchmark.ts: the snapshot-timing-unknown result carries a detail line (snapshot count, how many have a cash capture time, ambiguous count and the last ambiguous timestamp, clean days left).
- Files: src/lib/benchmark.ts, test/benchmark-flow-display-provenance.test.ts.

## Decisions & Trade-offs
- Detail only; no change to when a comparison is withheld.

## Verification State
- tsc and vitest run in CI (local install lacks the built shared package).

## Next Steps & Blockers
- Read the benchmark_timing_unknown row for the Tradier Sandbox account from /api/ops/snapshot and fix the named cause.

## Zero-Code Findings
None.

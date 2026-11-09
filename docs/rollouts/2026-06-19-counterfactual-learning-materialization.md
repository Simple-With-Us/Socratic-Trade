# 2026-06-19 - Counterfactual learning materialization

## Summary

- Added durable, user-scoped skipped-candidate counterfactual rows backed by
  `skipped_candidate_counterfactuals`.
- Added `counterfactual_learning_watermarks` so each user ingests new
  `signal_snapshot` audit rows idempotently.
- Added `materializeSkippedCandidateCounterfactuals(...)`, which extracts skipped
  candidates from full EvidenceDigest snapshots, waits for the configured OHLC
  horizon, and stores exit price/date plus return percent when a real OHLC bar is
  available.
- Strategy runs trigger the materializer as a bounded background refresh after
  `signal_snapshot` is written.
- `getSkippedCandidateReturns(...)` now prefers matured durable rows before the
  existing current-scan fallback.

## Why

Phase 10 B3 already had decision-time skipped evidence and prompt-time
current-scan missed-opportunity summaries. That was useful, but not durable: old
misses disappeared from prompt context unless the symbol was still in the current
scan. Materialized forward returns make skipped-name learning inspectable and
reusable without fabricating outcomes.

## Files

- `src/lib/db.ts`
- `src/lib/counterfactual-learning.ts`
- `src/lib/performance.ts`
- `src/lib/strategy.ts`
- `test/counterfactual-learning.test.ts`
- `docs/phase-10-signals-learning-ui-v2.md`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-19-counterfactual-learning-materialization.md`

## Verification

- `npx vitest run test/request-user.test.ts test/counterfactual-learning.test.ts test/policy.test.ts test/reconciliation-risk.test.ts` - passed, 34 tests across 4 files.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 223 tests across 30 files.
- `npm run build` - passed.

## Follow-ups

- Add post-mortem and tuning summaries that explicitly compare materialized
  skipped winners/losers to chosen outcomes.
- Surface materialized misses in the learning-matrix UI with sample-size gates.

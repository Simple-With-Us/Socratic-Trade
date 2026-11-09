# 2026-06-27 - Congress PIT readiness gate

## Summary

- Added App B enforcement for App A PR #96 PIT readiness markers.
- `npm run eval:congress-score -- --input ...` now refuses Congress.Trade export
  envelopes with `validationReadiness.historicalValidationReady=false` and exits `2`.
- PIT rows with row-level `pitValidity.scoreInputsPitSafe=false` or
  `pitValidity.historicalValidationReady=false` are dropped before scoring metrics.

## Why

- App A now distinguishes PIT-safe score inputs from full historical-validation readiness.
  App B must preserve that distinction so reconstructed/history-seeded exports are never
  accidentally treated as evidence of historical alpha.

## Files

- `docs/congress-score-evaluation.md`
- `docs/congress-trade-consume.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/rollouts/2026-06-27-congress-pit-readiness-gate.md`
- `PLAN.md`
- `scripts/eval/run-congress-score.ts`
- `src/lib/congress-score-eval.ts`
- `STATUS.md`
- `test/congress-score.test.ts`

## Verification

- `npm ci --cache .npm-cache` - installed dependencies using a worktree-local cache because
  the global npm cache has root-owned files.
- `npx vitest run test/congress-score.test.ts --testTimeout=20000` - 1 file / 15 tests passed.
- CLI not-ready fixture: `npm run eval:congress-score -- --input <fixture> --horizon-days 63`
  refused `validationReadiness.historicalValidationReady=false` and returned expected exit `2`.
- `npm run lint` - 0 errors / 225 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - 153 files / 1,485 tests passed.
- `npm run build` - passed.

## Follow-ups

- Re-run authenticated App A exports once App A sets `historicalValidationReady=true`.
- Keep whole-pipeline ablations separate from score-level IC validation.

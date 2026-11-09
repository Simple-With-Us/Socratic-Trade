# 2026-06-27 - Congress score evaluation

## Summary

- Added an App B Congress.Trade composite score that is direction-aware, confidence-capped,
  source/provenance-labeled, and advisory by default.
- Added a strict point-in-time score evaluator for historical App A exports and forward
  App B `signal_snapshot` evidence.
- Stored Congress composite fields in candidate evidence and added a signal-efficacy bucket
  for chosen long trades with strong BUY Congress context.
- Guarded Market Scan candidate promotion so weak/proxy-only analytics cannot pull symbols
  into the scored set.

## Why

- Congress.Trade context should be one small, testable input to the broader trading app,
  not an opaque raw-conviction shortcut.
- Historical evaluation must avoid lookahead leakage from trade dates, current-state member
  skill, top-level horizon bypasses, and post-overlay App B scores.
- The app needs both a forward measurement path and an App A data contract before making
  any portfolio P&L or live-trading trust claims about congressional signals.

## Files

- `app/ui/symbol-drilldown.tsx`
- `docs/congress-score-evaluation.md`
- `docs/congress-trade-consume.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/rollouts/2026-06-27-congress-score-evaluation.md`
- `package.json`
- `PLAN.md`
- `scripts/eval/run-congress-score.ts`
- `src/lib/congress-score.ts`
- `src/lib/congress-score-eval.ts`
- `src/lib/evidence.ts`
- `src/lib/market.ts`
- `src/lib/performance.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `src/lib/web-sources/congress-analytics.ts`
- `src/lib/web-sources/index.ts`
- `src/lib/web-sources/types.ts`
- `STATUS.md`
- `test/congress-analytics.test.ts`
- `test/congress-score.test.ts`
- `test/market.test.ts`

## Verification

- `npm ci` - installed isolated worktree dependencies; npm reported existing moderate
  audit warnings.
- `npx vitest run test/congress-score.test.ts test/congress-analytics.test.ts test/market.test.ts test/evidence.test.ts test/performance.test.ts test/backtest.test.ts --testTimeout=20000` - 6 files / 121 tests passed.
- `npm run eval:congress-score -- --help` - CLI/help path works and documents the strict
  PIT input contract.
- Synthetic positive PIT export: 3,900 observations, 65 dates, 60 tickers, rank IC
  `0.989808`, top-minus-bottom `0.089342`, placebo IC `0.00061`, go/no-go pass.
- Synthetic inverted PIT export: 3,900 observations, rank IC `-0.989899`,
  top-minus-bottom `-0.089641`, go/no-go fail with expected exit `2`.
- `npm run lint` - 0 errors / 225 pre-existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - 153 files / 1,484 tests passed.
- `npm run build` - passed; Next.js production build completed.

## Follow-ups

- Request and evaluate the App A `/api/export/congress-pit-scores` dataset with true
  PIT member-skill vintages, adjusted total returns, stable security identifiers, and
  placebo/null exports.
- Add whole-pipeline ablations: candidate inclusion, deterministic rank, LLM selection,
  risk/policy pass-through, skipped-name counterfactuals, and realized P&L.
- Add future evidence fields such as `includedByCongress`, `rankBeforeCongress`,
  `rankAfterCongress`, `finalDecisionInfluence`, and `congressOnlyOutlier`.
- Keep Congress committee-sector overlap as context with `legalConclusion:false`, not
  as alpha or an accusation, until separately validated.

## Blockers

- The current local App B database has no usable historical Congress-composite snapshots,
  so real historical validation is blocked on App A providing a PIT export.

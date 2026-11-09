# 2026-06-17 - technical-evidence-plumbing

## Summary

Evaluated Codex's "Stronger Trading Signals And Learning Loop" plan against the
current codebase and implemented the one clearly-beneficial, low-risk, zero-cost
gap that remained: **finishing the end-to-end plumbing of already-fetched technical
/ risk fields** (the plan's #1 priority — "finish plumbing existing fields before
adding new providers"). Paper mode unchanged. `tsc` clean, 122 tests, build ok.

`shortPercentOfFloat`, `beta`, `pbRatio`, and the 52-week high/low were fetched by
Yahoo and merged onto `MarketQuote`/`MarketQuoteSummary`, but — like the earlier
`fcfYield`/`senateTrades` bug — they never reached the agent prompt, the factor
scores, or the UI. Now:

- **Prompt**: `compactMarketScanForPrompt` emits `pb`, `shortFloat`, `beta`, and a
  computed `range52w` (0 = at 52-week low … 100 = at the high), with an instruction
  explaining the technical/positioning reads (range52w breakout vs falling-knife;
  high short float = squeeze potential *and* bearish positioning; high beta = size
  cautiously; low P/B = possible value).
- **Scoring**: `momentumScore` now blends the 52-week position with intraday change
  (near the high = stronger momentum); `volatilityScore` factors beta (high beta
  scores as riskier). Both are no-ops when the data is absent, so existing tests
  are unaffected.
- **UI**: new default-hidden **Short %** and **Beta** scan columns (available via
  the column gear), with source/methodology tooltips.

## Plan evaluation (what was already done vs. this pass)

Already implemented earlier this session: field plumbing (fcf/de/epsGr/senate),
10-tag thesis playbook, `signal_snapshot` EvidenceDigest, thesis×regime scorecard +
20-lot gate + 5-trade shrinkage, congressional (Senate eFD/Capitol Trades) + SEC
Form 4 connectors, FRED macro + deterministic regime (now rates-aware),
`candidates_considered` counterfactual log, signal-efficacy feedback, holding
horizon. **This pass** adds the remaining orphaned technical fields.

Deliberately deferred (higher effort / lower marginal value, documented as
follow-ups): sector as a 4th learning dimension (needs sector on closed lots);
new providers (FINRA short-sale volume, Cboe put/call, Kenneth French factors —
free but each a new connector; FMP/Alpha Vantage analyst-estimate/options endpoints
are rate-limited on the current key); raw filings/transcript/options async
digesting; counterfactual learning from the skipped-candidate log (needs price
tracking of un-traded names).

## Files

- `src/lib/market.ts` (`pricePosition52w`, `momentumScore`, `volatilityScore`),
  `src/lib/strategy.ts` (prompt fields + instruction), `app/dashboard-client.tsx`
  (Short %/Beta columns), `test/market.test.ts`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 122 passed
npm run build      # succeeds
```

Live `/api/scan` confirms all candidates now carry beta / shortPercentOfFloat /
52-week range from Yahoo (e.g. JPM β1.0 short 1.07%, LLY β0.52).

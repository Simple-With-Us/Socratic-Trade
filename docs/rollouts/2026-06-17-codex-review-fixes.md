# 2026-06-17 - codex-review-fixes

## Summary

Evaluated a Codex review of the signals/learning work and implemented the four
correct, beneficial findings (the fifth — "staged changes lack a rollout doc" — was
stale; docs have since been committed). Branch `web-sources`. Paper mode unchanged.
`tsc` clean, 129 tests, build ok; live-verified.

1. **Event candidate union (the key fix).** Previously `scanMarket` sliced + scored
   the top-N screener names *before* overlaying web signals, so a freshly-disclosed
   congressional/insider/short name that scored below the cutoff could never become a
   candidate — undercutting the whole point of scraping that data. Now `scanMarket`
   reads cached web signals for the *full* ranked universe, unions in up to
   `EVENT_CANDIDATE_RESERVE` (8) "event" names (net congressional buying, insider
   buying ≥60, or elevated short ≥55%) that scored below the cutoff, and enriches +
   scores the union (trimming the lowest top names to stay within the enrichment
   cap). `hasNotableWebSignal` is unit-tested.
2. **Honest source attribution.** The web-source overlay now stamps per-field
   provenance (`sources.senateTrades = "congress"`, `sources.insiderSentiment =
   "sec-edgar"`) and appends the contributing web sources to `MarketScan.source`.
   Live: `…+yahoo-finance+finra+congress+robinhood-quotes`, with NVDA/ORCL showing
   `senateTrades` sourced from `congress`.
3. **`/api/scan` now merges broker quotes.** The standalone Market Scan endpoint
   called `scanMarket()` only; it now also `mergeQuoteData()`s live broker bid/ask
   for the top candidates, matching the strategy-run path. Live: all 30 candidates
   now carry `bid`/`ask` (the Bid/Ask columns finally populate).
4. **`shrinkPrior = 0` now means "no shrinkage."** Validation allowed 0 but
   `resolveShrinkPrior` fell back to the default unless `v > 0`; changed to `v >= 0`
   so 0 disables shrinkage as intended.

## Findings judged not actionable

- "Recompute score/factorBreakdown after overlay" — a no-op today because
  congress/insider/short aren't scoring inputs; making them a deterministic
  sub-score means a new `ScoringWeights` factor (high churn). Deferred in favor of
  the candidate union, which achieves the discovery goal; the LLM still gets the
  smart-money evidence + bulletins.
- Process-gap finding (no rollout doc) — stale; addressed in prior commits.

## Files

- `src/lib/market.ts` (event union, `hasNotableWebSignal`, source stamping),
  `app/api/scan/route.ts` (broker merge), `src/lib/performance.ts`
  (shrinkPrior ≥ 0), `test/market.test.ts`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 129 passed (+2: hasNotableWebSignal)
npm run build      # succeeds (clean .next; the dev server must be stopped first)
```

Live `/api/scan`: source `…+finra+congress+robinhood-quotes`; senateTrades stamped
`congress`; 30/30 candidates carry bid/ask.

## Still deferred (Codex "best next")

Smart-money/catalyst deterministic sub-score; fuller EvidenceDigest for skipped
candidates; adaptive prompt compaction (omit neutral fields); SEC 8-K bulletins;
options/put-call; analyst-revision/earnings calendar; market breadth; Kenneth French
factors; symbol drilldown drawer + learning matrix UI.

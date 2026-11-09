# 2026-06-16 - llm-token-and-learning

## Summary

Token-efficiency and learning-loop improvements to the LLM calls that drive
trade proposals, so the agent reasons over higher-signal context at lower token
cost and actually learns from realized outcomes. No broker/execution behavior
changed; Paper mode remains the default and all policy gating is untouched.

Three changes, each combining a token win with a decision-quality win:

1. **Outcome-aware "Thesis Scorecard" (the learning loop's missing half).**
   The reflection loop previously reflected on recent trades **without knowing
   which made or lost money**, so it could not actually learn from
   success/failure. Added `getThesisScorecard()` in `performance.ts`: it walks
   closed lots (FIFO P&L, already computed) and attributes each realized
   outcome to the `tradeThesisTag` the position was **opened** under, producing
   `{ thesisTag, trades, winRate, avgReturnPct, totalPnl }`. This is computed
   deterministically in code (zero LLM tokens) and injected as
   `tradeOutcomesByThesis` into:
   - the **Bull** agent (with a system-prompt instruction to lean into thesis
     types with a positive track record and avoid repeat losers), and
   - the **post-mortem reflection** (so the lesson is grounded in realized P&L).
   `calculatePnl` now carries `symbol/thesisTag/regime` onto each closed lot
   (additive; win-rate/avg-return math unchanged).

2. **Gated post-mortem reflection (token + prompt-cache win).**
   `generateReflectionSummary` ran on **every** strategy run, re-summarizing up
   to 50 trades each time, and mutated the Bull system prompt every run — which
   defeats the provider's automatic prompt caching on the largest call. It now
   computes a signature `(#filledTrades, latestFillTime)` and **skips the LLM
   call when the trade history is unchanged** since the last reflection. That
   saves a whole call on the common run where nothing filled and keeps the Bull
   system-prompt prefix stable run-to-run so the cache can hit. Rationales fed to
   the reflection are also truncated to 240 chars.

3. **Trimmed redundant prompt context (token win).**
   - The Bull no longer ships the **entire allowlist** when it is large (e.g.
     the full S&P 500 ≈ 500 tickers, mostly redundant with the scored
     `marketScan` candidates); it sends a compact note + a 20-symbol sample.
   - `recentOrders` went from 20 raw broker objects to a slim 8-record slice.
   - The **Bear/critique** agent no longer receives a second full copy of the
     market scan + allowlist; it gets only the candidates under review (the
     symbols the Bull proposed) plus macro/limits/portfolio/scorecard.

## Why

- The single highest-leverage change for "make wiser buys/sells and learn from
  mistakes" is making the feedback loop **outcome-aware**. The infrastructure
  (thesis tags on proposals, FIFO closed-lot P&L) already existed but was never
  joined; the scorecard joins them at ~30 tokens of prompt cost.
- Re-summarizing the same history every run and re-sending the full scan/allowlist
  twice per run was the bulk of avoidable token spend, and the every-run
  reflection update was silently preventing prompt-cache hits.

## Files

- `src/lib/performance.ts` — `ThesisStat`, `getThesisScorecard()`,
  `thesisMetaFromFill()`; `calculatePnl` closed lots now carry thesis/regime.
- `src/lib/strategy.ts` — Bull prompt + `tradeOutcomesByThesis`; allowlist cap;
  `compactRecentOrders()`; slimmed Bear context.
- `src/lib/post-mortem.ts` — outcome-grounded + gated reflection; rationale
  truncation; records `reflection_signature`.
- `test/performance.test.ts` — two `getThesisScorecard` tests (win/loss
  attribution by thesis; Untagged bucketing).

## Verification

```bash
npx tsc --noEmit   # 0 errors
npm test           # 82 passed (11 files; +2 scorecard tests)
npm run build      # succeeded
```

The `runStrategyOnce` persistence test still passes, confirming the gated
post-mortem path (and the "Post-mortem LLM call failed" graceful no-key path)
is intact.

## Follow-up pass (same day): MAE/MFE + regime + delta-macro

The three deferred items below were then implemented in a second commit on the
same branch:

1. **MAE/MFE excursion lessons.** `getExcursionsByThesis()` (`learning-loop.ts`,
   replacing the old `runPostMortems` stub) fetches each recent closed lot's
   holding-period high/low via the existing `calculateExcursions` and aggregates,
   per thesis, avg MAE (pain endured), avg MFE (move available), and `capturePct`
   (share of the favorable move realized — low ⇒ exiting winners early). Bounded
   to 16 lots, injectable `compute` for testing, and called only in the gated
   async post-mortem so the proposal hot path makes no network calls.
2. **Regime-conditioned outcomes.** `getRegimeScorecard()` mirrors the thesis
   scorecard grouped by `entryMarketRegime`. Closed lots now carry
   `regime/side/entryPrice/entryAt/exitAt`; aggregation was refactored into a
   shared `aggregateClosedLots`. `tradeOutcomesByRegime` is fed to the Bull (told
   to compare today's regime to its history), the Bear, and the reflection.
3. **Delta-only macro pruning.** `pruneMacro()` (`macro.ts`) sends only macro
   fields that changed since the last run, always keeping regime-critical ones
   (VIX, Fed funds, 10Y, asOf), and lists the rest as `unchangedSinceLastRun`.
   Strategy stores the last macro via `setInternalSetting("last_macro_sent")`.

Adversarially reviewed (3 reviewers + per-finding verification): P&L/scorecard
math and integration came back with **zero findings** (FIFO P&L confirmed
behavior-preserving, no import cycles, network-safe, no execution-path change);
the one confirmed item was a nit — the reflection prompt referenced the proposal
field names (`tradeThesisTag`/`entryMarketRegime`) instead of the serialized stat
keys (`thesisTag`/`regime`), now reworded.

Verified: `npx tsc --noEmit`, `npm test` (86 passed; +4 tests:
regime scorecard, `pruneMacro`, excursion aggregation), `npm run build`.

## Follow-ups

- Excursions are computed live each gated reflection (network); if reflection
  cadence rises, persist MAE/MFE per closed lot to avoid refetching bars.
- A combined thesis × regime cell (e.g. "Momentum in High-VIX") would be even
  sharper than the two separate scorecards, once enough closed trades exist.
- The allowlist-cap and Bear-trim remain conservative; once telemetry confirms no
  proposal-quality regression, the candidate fan-out to the Bull could be pruned
  by score.

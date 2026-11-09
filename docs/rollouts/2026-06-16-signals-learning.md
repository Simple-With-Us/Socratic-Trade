# 2026-06-16 - signals-learning

## Summary

Implemented the tractable, low-risk pieces of Codex's "Research Plan: Stronger
Trading Signals And Learning Loop" on branch `ui-redesign`. The plan's explicit
first directive — *"finish plumbing existing fields end-to-end before adding new
providers"* — is now done for the five already-fetched fundamentals/alt-data
fields, plus three learning-loop hardening changes. Paper mode remains the
default; no live-trading behavior changed.

Four shipped capabilities:

1. **Fundamentals/alt-data plumbed end-to-end into scoring, prompt, and UI.**
   `fcfYield`, `debtToEquity`, `epsGrowth`, `insiderSentiment`, and `senateTrades`
   were already typed, fetched, and merged through the enrichment cascade but
   dead-ended there — they never reached the factor scores, the agent prompt, or
   the dashboard. Now:
   - **Scoring** (`src/lib/market.ts`): `valueScore` rewards free-cash-flow yield
     (`>=6% → +12`, `>=3% → +6`, `<0 → -8`); `qualityScore` rewards low leverage
     (normalized D/E `<=0.5 → +10`, `<=1.5 → +3`, `>3 → -10`) and EPS growth
     (`>=15% → +8`, `>0 → +3`, `<-10% → -8`). Both clamp to 0–100.
   - **Prompt** (`src/lib/strategy.ts`): `compactMarketScanForPrompt` now emits
     `fcfYieldPct`, `debtToEquity`, `epsGrowth`, `insiderSentiment`, and
     `senateTradesNet` per candidate, and the Bull prompt has an explicit
     "justify each proposal from this structured evidence, not vibes" instruction
     enumerating the available fields.
   - **UI** (`app/dashboard-client.tsx`): the Market Scan table gained three
     columns — **FCF%**, **D/E**, **EPS gr** — with source-attribution tooltips
     and up/down coloring on EPS growth. Cells show `—` when a provider didn't
     supply the value (never a fabricated number).

2. **Fixed thesis playbook (bounded vocabulary).** Added `THESIS_PLAYBOOK` (10
   tags: Momentum-Breakout, Mean-Reversion, Value-Quality, Earnings-Catalyst,
   Analyst-Revision, Insider-Accumulation, Short-Squeeze-Risk, Defensive-Rotation,
   Sector-Relative-Strength, Risk-Exit). Both the Bull and Bear JSON schemas now
   constrain `tradeThesisTag` to this enum (was free-form `{ type: "string" }`).
   The proactive risk-exit proposal tag changed `"Risk Management Exit"` →
   `"Risk-Exit"` to match. Free-form tags fragmented the thesis × outcome
   scorecards so no bucket ever accumulated enough samples to learn from.

3. **Bayesian shrinkage on the thesis/regime scorecards.**
   `src/lib/performance.ts` `aggregateClosedLots` now also returns `shrunkWinRate`
   and `shrunkAvgReturnPct`, shrinking toward a neutral prior (50% win, 0% return)
   with a 5-trade pseudo-count (`SHRINK_PRIOR = 5`). A single 100%-win trade
   reports as ~58% shrunk, not a misleading 100%. The Bull prompt instructs the
   agent to prefer the shrunk rates when `trades` is small.

4. **Counterfactual logging of skipped candidates.** `runStrategyOnce` now writes
   a `candidates_considered` audit event per run recording what the agent
   **chose** (symbol/side/status/thesisTag) vs the **top-ranked scan candidates it
   skipped** (top 8 by score, with score/sector/intradayChangePct). This is the
   raw material for future counterfactual learning ("what we passed on") without
   fabricating fills for names that never traded.

## Why

Codex's plan ordered the work: plumb existing fields first, then add a
SignalSnapshot/EvidenceDigest layer, deterministic provenance-tracked sub-scores,
multi-dimensional (thesis × regime × sector × factor) learning with a 20-lot gate,
async digests, and a raft of new providers (Alpha Vantage, FMP, SEC EDGAR, FINRA,
Cboe, FRED, Kenneth French). An audit against the codebase showed the five fields
were the highest-value, lowest-risk gap: the data was already being fetched and
paid for but silently discarded before it could influence a decision or be seen.
The thesis-enum + shrinkage + counterfactual-log changes are the minimal learning-
loop hardening that makes the *next* (larger) phase tractable — a bounded thesis
vocabulary and shrunk small-sample stats are prerequisites for any thesis × regime
× sector learning to converge.

## Files

- `src/lib/market.ts` — `valueScore` (FCF yield) and `qualityScore` (D/E + EPS
  growth) enrichment; both now clamp.
- `src/lib/strategy.ts` — `THESIS_PLAYBOOK` + `THESIS_PLAYBOOK_GUIDE`; Bull/Bear
  schema enums; new prompt evidence fields in `compactMarketScanForPrompt`;
  shrunk-rate prompt guidance; `candidates_considered` audit in `runStrategyOnce`;
  proactive risk-exit tag rename.
- `src/lib/performance.ts` — `SHRINK_PRIOR`; `shrunkWinRate`/`shrunkAvgReturnPct`
  on `ThesisStat`/`RegimeStat` and `aggregateClosedLots`.
- `app/dashboard-client.tsx` — FCF% / D/E / EPS gr scan columns + cells.
- `test/market.test.ts` — "rewards strong fundamentals in the value and quality
  sub-scores" (weak vs strong fundamentals).
- `test/performance.test.ts` — shrinkage assertions (1-trade Momentum → 58% /
  3.33%).

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 93 passed (14 files)
npm run build      # succeeds (full route table)
```

Market Scan tab verified in-browser (dark): the three new column headers render
in order (… P/E, FCF%, D/E, EPS gr, Div, …). Cells show `—` under the mock
provider because it doesn't supply these fields — correct behavior (no fabricated
numbers), and they populate from Yahoo/Finnhub/FMP when those providers run.

## Follow-ups (deferred from the plan — explicitly NOT built this pass)

- **New providers**: Alpha Vantage, FMP, SEC EDGAR, FINRA short-interest, Cboe,
  FRED, Kenneth French factor returns.
- **SignalSnapshot / EvidenceDigest layer**: a persisted per-run signal object
  and async-digested filings/transcripts/options bulletins (keeping raw text out
  of the prompt).
- **Deterministic sub-scores with provenance** beyond the current 7 factors
  (mean-reversion, positioning, explicit volatility/sentiment provenance).
- **Multi-dimensional learning**: thesis × regime × sector × factor bucketing with
  a min-20-closed-lot gate before a bucket influences sizing, and feeding the new
  `candidates_considered` log into the reflection/post-mortem.
- **Min-sample gate on strategy-tuning weight suggestions** (currently shrinkage
  tempers the prompt, but the tuner doesn't yet hard-gate on sample size).

These are larger and higher-risk; offered as the next phase pending user go-ahead.

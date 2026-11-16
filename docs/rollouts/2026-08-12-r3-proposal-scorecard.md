# 2026-08-12 — r3: unified ProposalScorecard (typed deterministic decision receipt)

## Context & Objective

External-repo lessons round 3 (CLAUDE lane).  Lesson from ZhuLinsen/daily_stock_analysis's
validated Dashboard contract: the decision receipts already scattered across `TradeProposal`
(rationale, brackets, red-team verdict, sizing snapshot, dataAdjustments, policy reasons) become
ONE typed, renderable artifact — `ProposalScorecard`.  The gap analysis explicitly warns against a
monolithic LLM-authored schema, so every field is a deterministic receipt assembled from state the
pipeline already computed; no new LLM call, no new authority.

## Changes Made

- **`src/lib/types.ts`** — `ProposalScorecard` + `ProposalScorecardChecklistItem` + `DecisionStep`;
  `TradeProposal.scorecard?` (additive/optional, mirroring the sizingSnapshot pattern — existing
  fixtures untouched); `SocraticDecisionCase.outcome.sniperAccuracy?` receipt;
  `TradingPolicy.secondaryBuyPullbackPct?` owner knob (default undefined = level omitted);
  `SocraticDecisionTrace.scorecard?` for the read-only trace render.
- **`src/lib/market.ts`** — `computeSignalAttribution(quote)`: four integer buckets
  (liquidity+momentum → technical, sentiment → news, value+quality → fundamentals,
  positioning+volatility+diversification → market) normalized to sum EXACTLY 100
  (largest-remainder rounding, same safeWeight idiom as normalizeWeights).  Undefined without a
  factor breakdown or with all-zero factors.
- **`src/lib/strategy.ts`** — pure builders (`buildProposalScorecard`, `scorecardIndicatorsFromBars`,
  `appendDecisionStep`, all exported for tests) + wiring: the opening ATR precompute now also
  records SMA50/SMA200/20-day-avg-volume per symbol from the SAME cached bars (no new fetch); the
  placement loop assembles `normalizedProposal.scorecard` right after override resolution (all
  subsequent persist paths carry it); decision-chain steps appended exactly at the existing state
  stamps — `red_team_reject` at stampRedTeamResult's reject paths, `override_requested` where
  `redTeamVerdict.overridden` is set, `override_applied` where `socraticOverride.applied` audits,
  `final` before the autonomous placing insert.
- **`src/lib/strategy-execution.ts`** — `human_approved` appended exactly where
  `redTeamVerdict.humanOverrideApplied` is set; `final` before the approval placing claim (the
  claim persists the proposal JSON, chain included).
- **`src/lib/db-proposals.ts`** — `validateDecisionChain` (pure: known steps, consecutive steps
  must change, `override_applied` requires a preceding `override_requested`) runs at persistence
  time in `insertProposal` + `claimProposalForExecution`; a malformed chain logs a
  `proposal_decision_chain_malformed` audit receipt and the proposal is stored as-is — never
  thrown away.
- **`src/lib/outcome-engine.ts`** — `gradeSniperAccuracy` (pure, exported): did any post-basis
  DAILY CLOSE breach the scorecard's stop / reach its take-profit, side-aware, `priceBasis:
  "daily_close"` disclosing the close-only basis.  Wired into `measureCase` against the bars it
  already fetches (never a new fetch pipeline); receipt preserved across the intraday-sample
  worker's outcome rewrites.
- **Render** — new `app/console/components/proposal-scorecard.tsx` (con-card/con-chip primitives,
  SENTENCE_GAP-preserving two-space copy), collapsible inside `approval-card.tsx` and read-only in
  the decision trace (`app/console/decisions/[id]/page.tsx`; the trace API
  `app/api/socratic/decisions/[id]/route.ts` joins the proposal row's scorecard — the case stores
  no duplicate copy).
- **Owner knob surface** — `app/api/policy/route.ts` validation (0–100) +
  `app/console/guardrails/field-defs.ts` Entry quality row for `secondaryBuyPullbackPct`
  (display-only level; blank omits it).
- **Tests** — new `test/proposal-scorecard.test.ts` (23 tests).

Touched files: `src/lib/types.ts`, `src/lib/market.ts`, `src/lib/strategy.ts`,
`src/lib/strategy-execution.ts`, `src/lib/db-proposals.ts`, `src/lib/outcome-engine.ts`,
`app/api/policy/route.ts`, `app/api/socratic/decisions/[id]/route.ts`,
`app/console/guardrails/field-defs.ts`, `app/console/components/proposal-scorecard.tsx` (new),
`app/console/components/approval-card.tsx`, `app/console/decisions/[id]/page.tsx`,
`test/proposal-scorecard.test.ts` (new).

## Decisions & Trade-offs

- **No schema migration.**  The scorecard rides the `trade_proposals.proposal` JSON blob; the
  decision trace joins it by proposalId instead of duplicating it onto `socratic_decisions`.
- **Checklist = rendering, not authority.**  Rows exist only for checks that actually ran:
  entry-drift (its `entry_drift:` reason prefix / configured guard), wash-sale (BUYs only, from
  `decision.washSale`), daily-cap (escalation kinds + sizingSnapshot headroom), red-team verdict,
  dataAdjustments presence.  A disabled guard produces no row rather than a fake pass.
- **MA/volume context is opportunistic**: recycled from the ATR precompute's bars, so when
  `atrStops` is off and no opening carries an "atr" plan, the fields are honestly omitted
  (`maAlignment: "unknown"`) rather than triggering a new fetch.
- **Sniper grading is close-basis only** (the outcome engine's daily series carries no
  high/low); the receipt discloses `priceBasis: "daily_close"`.  Bars strictly AFTER the basis
  date participate.
- **`secondaryBuyPullbackPct` is informational** — rendered on the scorecard, never traded from.
  Default undefined omits the level entirely (never a silent hardcoded number).
- **Scorecard digest notification deliberately NOT built** (spec item 8 — the watchlist digest
  exists; a scorecard digest stays deferred).
- Early-blocked paths (tradability, broker-minimum) persist without a scorecard — they die before
  the policy gate whose state the checklist mirrors; the render surfaces handle absence.

## Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # node v24.19.0
npx tsc --noEmit                                     # clean
npx vitest run test/proposal-scorecard.test.ts       # 23/23
npx vitest run test/outcome-engine.test.ts test/outcome-engine-due-jobs.test.ts \
  test/proposal-data-adjustments.test.ts test/market.test.ts            # 71/71
npx vitest run test/guardrails-essentials.test.ts test/console-policy-diff.test.ts \
  test/approvals-triage-model.test.ts test/pre-veto-override.test.ts \
  test/approval-limit-reprice.test.ts                                   # 73/73
npx vitest run test/broker-minimum-bump-execute.test.ts \
  test/account-mutation-pr2-strategy-loop.test.ts test/approval-lock.test.ts  # 15/15
```

No `db.ts` migration touched (schema-version assertions unchanged).  Full lint/test/build run at
land time per the slice-gate contract.

## Next Steps & Blockers

- Land via the round-3 integration lane (this is a local-only slice commit on `agent/claude`).
- Optional follow-ups: render `outcome.sniperAccuracy` on the decision trace's Outcome card; PWA
  scorecard render (PWA lacks con-* tokens — same deferral as the symbol drawer).
- Blockers: none.

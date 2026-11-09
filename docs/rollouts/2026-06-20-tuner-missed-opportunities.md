# 2026-06-20 — Auto-tuner learns from missed opportunities

## Summary
Wired materialized "missed opportunity" evidence into the strategy auto-tuner
(`proposeStrategyTuning`). The tuner now receives the high-scoring candidates the
strategy SKIPPED that subsequently rose over their horizon (matured
skipped-candidate counterfactuals), plus a `recurringFactor` signal when one
dominant factor recurs across the missed winners. Both the LLM tuning path and the
no-API `localRulesProposal` fallback use it.

## Why
Phase 7 and Phase 10 both flagged "post-mortem/tuning use of materialized
missed-opportunity rows" as remaining. The data was already materialized and used
by the live strategy Bull prompt (`strategy.ts:756` via `getSkippedCandidateReturns`),
but the auto-tuner — the component that proposes scoring-weight changes — was blind
to it. Surfacing it lets the tuner reason about whether the current `scoringWeights`
systematically under-weight a factor that keeps showing up in the names it passes on
(still subject to the existing >=20-closed-lot sample-size guardrail before any weight
change is allowed).

## Files
- `src/lib/strategy-tuning.ts` — new exported `summarizeMissedOpportunities()` plus
  `MissedOpportunityInput`/`MissedOpportunitySummary` types. `proposeStrategyTuning`
  now fetches matured missed-opps via `getSkippedCandidateReturns({}, userId, …)`
  (empty price map => matured rows only, so no live quotes are needed), adds them to
  the LLM context only when non-empty, documents them in the system prompt, and feeds
  a recurring-factor caution into the local fallback.
- `test/strategy-tuning-missed-opps.test.ts` — unit tests for the pure
  `summarizeMissedOpportunities` logic (winner filtering incl. zero-return exclusion,
  item shaping, recurring-factor detection, limit/count separation, empty case).

## Verification
- `npx tsc --noEmit`, `npm test`, `npm run build` — recorded in the commit/PR.
- No DB schema, risk, P&L, or order-accounting code touched — this is additive,
  read-only evidence flowing into an existing review-only proposal path. The tuner
  remains review-only; nothing is auto-applied.

## Follow-ups
- Post-mortem reflection (`src/lib/post-mortem.ts`) still does not use missed-opps —
  that is the remaining half of the Phase 7/10 item.
- `PLAN.md` phase 7 & 10 "Remaining" should drop the *tuning* side of
  "post-mortem/tuning use of materialized missed-opportunity rows" (left for the
  integration seat to edit, to avoid colliding with its live STATUS/PLAN edits).
- Delivered on branch `feat/tuner-missed-opportunities` via PR for integration-seat merge.

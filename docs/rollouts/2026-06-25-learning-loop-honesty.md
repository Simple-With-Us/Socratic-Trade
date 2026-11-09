# 2026-06-25 — Learning-loop honesty: OOS no-op caution + policy-blocked counterfactual

Branch: `claude/learning-loop-honesty` (off `origin/main`). First of the "clean/additive
backlog" batches the owner greenlit after PR #137. Both changes are **additive and
advisory-only** — they never touch the order/money path, only learning + operator honesty.

## Summary

1. **OOS walk-forward gate: surface a caution when it can't evaluate.** The gate
   (`applyOosGate` in `src/lib/strategy-tuning.ts`) silently kept the proposed factor
   weights and returned the proposal unchanged on three "can't run" paths — OOS fetch
   threw, `runWalkForwardOOS` returned null (<4 snapshot dates), or it returned no
   composite IC. An operator reading that silence could mistake it for an out-of-sample
   pass. Now each of those paths appends a caution: *"Proposed factor-weight changes were
   NOT out-of-sample validated (<reason>) — they are kept as proposed, so apply with extra
   care."* No gating-behavior change (weights are still kept), just honesty. Mirrors the
   repo's existing withheld-weights / validated-weights caution convention.

2. **Feed POLICY-BLOCKED opening proposals into the counterfactual pipeline.** The
   existing `recordRejectedProposalCounterfactual` covered USER-rejected proposals
   (`rejectProposal`). A proposal the LLM generated but the **policy gate** then blocked
   (`evaluateTradeProposal` → not approved, in `runStrategyOnce`) was persisted as
   `status: "blocked"` but never matured into missed-opportunity analytics. Now the
   post-review policy-block site records the same counterfactual — **opening sides
   (buy/short) only**, since a blocked exit is not a missed opportunity. Best-effort +
   non-fatal; reuses the INSERT-OR-IGNORE maturation path so it never double-counts and
   writes no fills/orders.

## Files

- `src/lib/strategy-tuning.ts` — `withOosUnvalidatedCaution` helper + applied at the three
  OOS skip sites in `applyOosGate`.
- `src/lib/strategy.ts` — `recordRejectedProposalCounterfactual` call at the post-review
  policy-block site in `runStrategyOnce` (opening-side gated, best-effort).
- `test/strategy-tuning.test.ts` — +2 cases: weights kept + "NOT out-of-sample validated"
  caution when OOS returns null (insufficient snapshots) and when it throws.

## Verification

```
npx tsc --noEmit   # clean
npx vitest run     # 1113/1114 (+2); only the pre-existing cache-provenance date flake
npm run build      # compiles green
```

The policy-blocked call is a thin, opening-side-gated wrapper around
`recordRejectedProposalCounterfactual`, which has its own coverage in
`test/rejected-counterfactual.test.ts`; tsc + that suite + the full build cover the wiring
(a full runStrategyOnce blocked-proposal harness wasn't warranted for a one-call addition).

## Follow-ups

Remaining clean/additive backlog batches (separate branches): read-only chat state tools;
`avgDaysHeld`/`shortTermPct` dashboard surface; persist MAE/MFE per closed lot; ATR-stops
opt-in mode; prompt-cache the strategy system prefix; SEC XBRL company-facts connector.

# 2026-07-15 — Per-position stop plans round 8: post-merge Codex follow-ups

## Summary

PR #1371 ("Per-position stop plans: LLM chooses stop type at open time") merged to `main` at
2026-07-11T07:39:12Z. Codex's automated reviewer posted 4 more findings against the merged commit
afterward (2026-07-11T07:51:39Z) — by the time this session picked them up, `main` had moved
substantially further (15+ intervening PRs, including a sub-millisecond order-race fix, an
account-relative risk hardening pass, and the "X0.3 Exit Replacement State Machine"), so each
finding was re-verified against the CURRENT code rather than assumed still accurate.

- **Fixed**: `src/lib/strategy-execution.ts`'s `reconcilePlacementError` — a shared
  `commitRecoveredOpeningStopPlan` helper already exists (added by other agents' subsequent
  hardening work) and is already called from the `dup` (already-booked) branch and from
  `flagStalePlacingIntents`, but the fresh (non-`dup`) `recordFillFromProposal` call in this same
  function never called it. A scale-in recovered via the placement-error retry path (order threw
  on placement but actually reached the broker) would never get its stop plan committed. Added the
  missing call, gated on `fillStatus === "filled" || fillStatus === "partially_filled"` matching
  the helper's existing call sites.
- **Fixed**: `src/lib/synthetic-stops.ts`'s trailing-row purge loop only matched
  `plan === "none" || plan === "fixed" || plan === "atr"`. A plan explicitly reset to `"default"`
  (the fill path clears the DB row, so the symbol is simply absent from `stopPlanBySymbol`) with
  no account-wide `trailingStopPct` configured fell through this condition entirely, leaving a
  stale synthetic trailing row armed at whatever distance the OLD plan used (its own fallback %,
  not the account's — which doesn't even have one configured). Extended the purge condition to
  also cover `(plan === undefined || plan === "default") && accountTrailPct <= 0`. When the
  account DOES have its own `trailingStopPct > 0`, the row is left alone — it's already trailing
  at a real, still-applicable distance.
- **Not reproducible against current `main`**: the finding claiming a partial fill's stop-plan
  basis gets "locked in" too early and never revisited as the blend evolves. Traced the actual
  current code: `listPendingBrokerReconciliationFills` explicitly includes `'partially_filled'`
  rows in its SQL filter (not just `'pending_reconciliation'`), so a partially-filled row IS
  revisited on every subsequent reconcile pass; and both `commitStopPlanIfOpening` (in
  `reconcilePendingFills`) and `commitRecoveredOpeningStopPlan` derive the recorded basis from the
  BROKER'S OWN live `position.averageCost` at call time (a fresh lookup each call), not a frozen
  single-fill price — so the basis self-corrects on every partial-fill revisit regardless of how
  many fills the order eventually takes to complete. This finding must have applied to some
  intermediate state of `reconcilePendingFills` that existed briefly around the merge, before the
  later hardening PRs' refactor (which introduced `mergedExecutionTruth`/`reconciledFillStatus`)
  landed. No changes made for this one.
- **Deferred, not fixed**: canceling a resting Alpaca bracket/OCO leg placed at an EARLIER opening
  when a scale-in resets the position's plan to `trailing`/`none`. `enrichOpeningProposal` only
  strips bracket fields from the NEW order being placed — it has no way to reach back and cancel
  the ORIGINAL entry's still-resting bracket sibling legs, because those are broker-side orders
  with no row in `broker_protective_stops` (which only tracks the app's own ratcheted/synthetic
  stops). This is the same underlying gap as the "OCO sibling-identity pairing" issue already
  flagged as deferred in PR #1331's review — fixing it precisely requires a broker API that can
  identify and cancel a bracket order's sibling legs by group ID, which neither Alpaca's nor
  Robinhood's current adapter surface exposes. Left open, consistent with that prior precedent —
  not something to guess at with a partial workaround on money-path order-cancellation code.

## Why

Continuing the same Codex-review triage discipline from the original PR, now against the shipped
code on `main`. The two "not reproducible" / "deferred" outcomes matter as much as the two fixes:
blindly re-applying a stale diff-time finding to code that's since been reworked by other agents
risks reintroducing already-fixed behavior or conflicting with newer architecture (e.g. the Exit
Replacement State Machine), so each finding was traced against the actual current implementation
before deciding whether a fix was still needed.

## Files

- `src/lib/strategy-execution.ts` — `reconcilePlacementError`'s fresh-fill branch now calls
  `commitRecoveredOpeningStopPlan`
- `src/lib/synthetic-stops.ts` — trailing-row purge condition extended for a default-reset plan
  with no account-wide trailing %

## Verification

```
npx tsc --noEmit   # clean
npm test           # 382 files / 4400 tests passed
npm run build      # clean (next-env.d.ts / tsconfig.json restored after)
npm run lint       # 0 errors, 488 pre-existing grandfathered warnings
```

## Follow-ups

- Still open (deferred twice now, PR #1331 and here): OCO/bracket sibling-leg cancellation needs
  a broker API capable of identifying and cancelling a bracket order's sibling legs by group ID.
- No further known Codex findings against PR #1371's merged code as of this rollout.

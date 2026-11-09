# 2026-07-11 — PR #1371 round 4: 32 Codex review findings fixed, merged forward from PR #1331

## Summary

- Merged `claude/stop-loss-preset-options-f1jygn` (PR #1331, round-10 fixes + `main`) into
  `claude/per-position-stop-plans` (PR #1371) — clean, no conflicts.
- Triaged all 27 previously-open Codex review threads on PR #1371 against the merged code, plus 5
  more from a fresh Codex round triggered by the merge push (32 total). All 32 fixed; resolved via
  the GraphQL `resolveReviewThread` mutation (the repo's automated Codex-Autofix bot, which normally
  does this, had been down — see PR #1331's round-10 rollout note for that story).

## Why

Continuation of the PR #1331 round-10 triage session — same root cause (the Codex-Autofix bot was
broken, so review threads piled up unaddressed across both this PR and its base). Picked up the
manual triage here too, following the bot's own protocol (separate outdated from live findings, fix
clear correctness bugs, verify, resolve threads).

## Files

- `src/lib/performance.ts` — `recordFillFromProposal` accepts `existingPosition` (pre-fill
  average cost + quantity) and a `stopPlanBasisOverride`; blends the stop-plan's recorded `avgCost`
  against the resulting post-fill position basis on a scale-in, instead of the single fill price.
- `src/lib/strategy.ts` — threads `existingPosition` through the autonomous-run and manual-approval
  `recordFillFromProposal` call sites; `reconcilePendingFills`/`flagStalePlacingIntents` use the
  broker's own live (already post-fill) `averageCost` via `stopPlanBasisOverride`; portfolio-heat
  budget calculation is now stop-plan-aware; a rationale-less "none" plan is dropped (not downgraded
  to "default"); an inherited scale-in plan's rationale is stamped onto the returned proposal.
- `src/lib/db-api-keys.ts` — `filterStopPlansByLiveBasis` moved here from `strategy.ts` (re-exported
  from there for existing consumers) so `synthetic-stops.ts` can share it without depending on
  `strategy.ts`; new `filterFullStopPlansByLiveBasis` (keeps the full `PositionStopPlan`, including
  rationale, for the dashboard's display-only use).
- `src/lib/synthetic-stops.ts` — applies `filterStopPlansByLiveBasis` to its own independently-loaded
  stop plans; stops re-registering a trailing row for "fixed"/"atr" plans in the same pass its purge
  just removed one.
- `src/lib/broker-protective-stops.ts` — tears down a "none"-plan symbol's resting broker stop even
  while the system is Stopped or live placement is blocked; books any fill executed before a
  per-symbol-plan-driven cancel completes; floors Alpaca MCP ratcheted trailing stops to whole shares
  (not just native REST) — Alpaca requires `time_in_force=day` for fractional stop orders, and this
  reconciler always sends `gtc`.
- `app/console/lib/derive.ts` — preserves the muted/unsafe base protection state for a short position
  with short selling disabled, instead of an active plan label the enforcement layers actually skip.
- `app/console/components/approval-card.tsx` — discloses an explicit `stopPlan.style === "default"`
  as a reset, instead of rendering it identically to no plan at all.
- `src/lib/dashboard.ts` — filters the Positions stop-plan display by live basis too.
- `app/console/guardrails/field-defs.ts` — `riskRules.trailingStopPct` gets `looserWhen: "up"`.
- `test/strategy-hardening.test.ts` — updated two tests that asserted the old (buggy) "none" →
  "default" downgrade behavior; now assert the field is dropped entirely.

## Verification

```
npx tsc --noEmit   # clean
npm run lint       # 0 errors, 379 pre-existing grandfathered warnings
npm test           # 319 files / 3558 tests passed
npm run build      # clean
```

## Follow-ups

- **Left open, not guessed at:** OCO sibling-identity pairing (`liveExitOrderCoverage` in
  `broker-side.ts`) — see the PR comment on #1331. Needs a broker API change (nested-order fetch +
  parent correlation) or an owner-accepted tradeoff to fix precisely.
- No new unit tests were added for the round-4 fixes themselves (blended basis, heat sizing,
  short-disabled label, dashboard basis filter) beyond the two existing tests updated for the
  "drop invalid none" behavior change — the existing suite (3558 tests) stayed green throughout,
  but dedicated coverage for these specific fixes would strengthen the regression net. Flagging as a
  reasonable next increment, not done this round (time-boxed to the Codex triage).
- Auto-merge was already enabled on PR #1331; recommend enabling it on #1371 too once this push's CI
  finishes, per repo convention (`gh pr merge <n> --squash --auto`).

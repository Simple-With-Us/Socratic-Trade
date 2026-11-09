# 2026-06-19 - live-safety-risk-controls

## Summary

- Added two optional policy tuning controls:
  - `redTeamConvictionThreshold` controls the confidence score that triggers Red Team review. Missing/invalid values preserve the existing 80 default.
  - `crisisMaxOpeningExposurePct` caps new buy/short order notional as a percentage of portfolio value when `entryMarketRegime` is crisis or inverted-curve. Missing or non-positive values disable the guardrail.
- Added deterministic policy enforcement for the crisis/inverted opening-exposure cap.
- Added compact Settings -> Tuning fields for both controls.
- Added focused tests for the red-team threshold and crisis cap behavior.

## Why

Phase 10 E4/E5 called out two live-safety gaps: the Red Team conviction trigger was hard-coded, and deterministic crisis/inverted regimes were context only. This slice makes both operator-configurable while preserving current behavior unless the crisis cap is explicitly configured.

## Files

- `src/lib/types.ts`
- `src/lib/policy.ts`
- `src/lib/strategy.ts`
- `app/api/policy/route.ts`
- `app/dashboard-client.tsx`
- `test/policy.test.ts`
- `test/reconciliation-risk.test.ts`
- `docs/phase-10-signals-learning-ui-v2.md`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-19-live-safety-risk-controls.md`

## Verification

- `npx vitest run test/request-user.test.ts test/counterfactual-learning.test.ts test/policy.test.ts test/reconciliation-risk.test.ts` - passed, 34 tests across 4 files.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 223 tests across 30 files.
- `npm run build` - passed.

## Follow-ups

- E4 still has broader scoring-threshold settings open: FCF/D-E/EPS buckets, regime VIX cutoffs, and edge-factor tiers.

## Blockers

- None.

# 2026-06-30 - Production Merge Sweep

## Summary

Created `codex/prod-merge-sweep-20260630` from `origin/main` to merge pending
production-ready work into one deploy path:

- `codex/settings-help-overhaul` / PR #267 settings scope and field-help work.
- `codex/settings-review-polish` review-action placement and Settings UI polish.
- `codex/alpaca-held-order-guard` / PR #268, reconciled after it landed on
  `main` as squash commit `44466cbb`.
- `codex/market-scan-source-labels` / PR #269 source-label dedupe for Latest
  Decisions and Market Scan.

The sweep also fixes the two review blockers that were preventing a clean
production push:

- Broker orders that are filled at the broker but still have only a
  `pending_reconciliation` local fill row remain `pending_order`/Working in the
  unified feed instead of assuming a local `filled` event exists.
- Legacy Strategy Studio model choices are migrated into every connected
  account row before `user_settings.policy` is reduced to user-level fields.

## Why

The user asked to get all not-yet-merged/deployed work to production ASAP. These
branches were the relevant production-safe active deltas, but PR review threads
identified one broker-feed crash risk and one migration-data-loss risk. Both
needed to be fixed before deployment. PR #271 was left out because its diff
reintroduced inline model lists/settings churn and a simulated `$100` quote
fallback outside `NODE_ENV=test`; that conflicts with the current settings
direction and the no-fabricated-data rule.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-30-market-scan-source-labels.md`
- `docs/rollouts/2026-06-30-prod-merge-sweep.md`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard-ui.ts`
- `src/lib/db-profiles.ts`
- `test/dashboard-feed.test.ts`
- `test/dashboard-ui.test.ts`
- `test/per-account-policy-isolation.test.ts`

## Verification

- `npx vitest run test/dashboard-feed.test.ts test/per-account-policy-isolation.test.ts` - pass, 2 files / 26 tests.
- `npm run lint` - pass, 0 errors / 255 existing warnings.
- `npx tsc --noEmit` - pass.
- `npm test` - pass, 164 files / 1574 tests.
- `npm run build` - pass.

## Follow-ups

- Open a ready PR, arm auto-merge, wait for required CI, and verify production
  after the deploy workflow updates `socratictrade.com`.

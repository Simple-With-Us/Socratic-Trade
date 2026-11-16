# 2026-06-23 - Codex bundle integration

## Summary

Prepared the current Codex preview bundle for integration through the repo's
normal landing path. The bundle includes the custom Additional Watchlist/error
surface work, expanded index universes, user-controlled Market Scan cap/outlier
reserve, app-local account deletion, account-row visual polish, and
stopped-system proposal action gating.

## Why

The user asked to commit and integrate the current Codex preview changes with
`codex.jays.services`, `trading-beta.jays.services`, and `socratictrade.com`
as appropriate. This repo does not hand-copy files between those sites:
`codex.jays.services` is the Codex worktree preview, beta is the `main`
integration worktree, and production deploys from `main` through the existing
GitHub Actions/self-hosted runner path.

## Decisions

- Treat the whole dirty Codex worktree as the requested integration scope.
- Use `scripts/land.sh` after committing, so the branch merges current
  `origin/main`, reruns the required gate, pushes the branch, and opens a PR.
- Do not edit `~/apps/trading-live` directly; production should update only
  after the `main` deploy workflow or documented fallback path succeeds.
- Keep the PR ready for review by repo convention, not draft.

## Files

- `PLAN.md`
- `STATUS.md`
- `app/api/account/deletion/route.ts`
- `app/api/policy/route.ts`
- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/[id]/reject/route.ts`
- `app/api/proposals/from-draft/route.ts`
- `app/api/scan/route.ts`
- `app/dashboard-client.tsx`
- `app/dashboard-types.ts`
- `app/error.tsx`
- `app/global-error.tsx`
- `app/layout.tsx`
- `app/page.tsx`
- `app/ui/global-error-toasts.tsx`
- `docs/architecture-blueprint.md`
- `docs/phase-11-multi-user.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-5-dashboard-refactor.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-23-codex-bundle-integration.md`
- `docs/rollouts/2026-06-23-custom-watchlist-errors.md`
- `docs/rollouts/2026-06-23-expanded-index-universes.md`
- `docs/rollouts/2026-06-23-market-scan-cap-settings.md`
- `docs/rollouts/2026-06-23-ui-account-deletion-visual-pass.md`
- `src/lib/account-deletion.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard.ts`
- `src/lib/data-providers.ts`
- `src/lib/db-proposals.ts`
- `src/lib/db.ts`
- `src/lib/defaults.ts`
- `src/lib/fund-holdings.ts`
- `src/lib/index-universes.ts`
- `src/lib/market.ts`
- `src/lib/mcp-oauth.ts`
- `src/lib/policy-symbol-validation.ts`
- `src/lib/policy.ts`
- `src/lib/proposal-actions.ts`
- `src/lib/robinhood.ts`
- `src/lib/scan-settings.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `src/lib/yahoo-finance.ts`
- `test/account-deletion.test.ts`
- `test/conviction-size-cap.test.ts`
- `test/dashboard-feed.test.ts`
- `test/fund-holdings.test.ts`
- `test/index-universes.test.ts`
- `test/market-custom-symbol.test.ts`
- `test/market-dynamic-universe.test.ts`
- `test/market.test.ts`
- `test/policy-custom-symbol.test.ts`
- `test/policy.test.ts`
- `test/proposal-action-state.test.ts`
- `test/scan-settings.test.ts`
- `vitest.config.ts`

## Verification

- `git diff --check` - passed.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 107 files / 936 tests.
- `npm run build` - passed.

## Follow-ups

- After the PR merges, sync/restart the beta integration preview if its
  worktree is clean.
- Confirm the production deploy run is green and smoke `socratictrade.com`
  after the main-branch deploy completes.

# 2026-06-19 - CI verification workflow deferred

## Summary

- Prepared a GitHub Actions CI workflow for pushes and pull requests targeting
  `main`, using the same required sequence documented in `AGENTS.md`: `npx tsc
  --noEmit`, `npm test`, then `npm run build`.
- GitHub rejected the push because the current OAuth app credentials do not have
  `workflow` scope, which is required to create or update `.github/workflows/*`.
- Removed the workflow file from the pushed commit and documented the blocker so
  the rest of the Phase 10/11 work can land cleanly.

## Why

The app is now split across multiple agents and worktrees. CI gives every
handoff a shared baseline so type, test, and build regressions are caught before
they reach `main`, but it needs to be added with credentials that can write
GitHub workflow files.

## Files

- `PLAN.md` - acceptance checklist now records local verification and the CI
  credential blocker.
- `STATUS.md` - current handoff status.
- `docs/rollouts/2026-06-19-ci-verification.md` - this rollout note.

## Verification

- `npx tsc --noEmit` - passed.
- `npm test` - passed, 223 tests across 30 files.
- `npm run build` - passed.

## Follow-ups

- Re-add `.github/workflows/ci.yml` using credentials with `workflow` scope, then
  consider branch protection so CI must pass before merges to `main`.

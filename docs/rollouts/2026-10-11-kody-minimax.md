# Kody MiniMax Rollout

## Context & Objective

Jay requested that the Muse-backed autofix use MiniMax.  CTS-330 tracks the fleet rollout.

## Changes Made

- `.github/workflows/kody-fleet-autofix.yml`: select `minimax/minimax-m3` and update the displayed workflow name.
- `.github/workflows/sentry-ci-report.yml`: match the renamed workflow in the observer and its inventory comment.
- `STATUS.md`: record verification and landing status.
- `PLAN.md`: record the model-selection approach and unchanged product roadmap.
- `docs/rollouts/2026-10-11-kody-minimax.md`: preserve this change and verification record.

## Decisions & Trade-offs

Keep the existing Vercel AI Gateway endpoint and credential, immutable reusable-workflow pin, enabled profile, budget, attempt cap, path restrictions, and shared per-PR concurrency group.  The change selects a model; it does not widen autofix access.

## Verification State

- `git diff --check`: passed.
- `actionlint -shellcheck= -pyflakes= .github/workflows/kody-fleet-autofix.yml .github/workflows/sentry-ci-report.yml`: passed.
- `npx --yes --package vitest@5.0.1 -- vitest run test/sentry-ci-report-workflows.test.ts --config <temporary-node-only-config>`: 3 tests passed.  The temporary config contains `export default { test: { environment: 'node' } };` and avoids requiring the app dependency tree for this workflow-only test.
- Shared helper synthetic canary: a live MiniMax M3 response parsed into an edit and applied successfully.  This proves API compatibility, not a production Kody fix.
- Hosted CI and current-head Codex review remain required before merge.

## Next Steps & Blockers

Land PR #4523 after review and required checks clear.  Preserve existing tracking for autofix execution issues; this provider change alone does not prove every bot is healthy.

## Zero-Code Findings

Renaming a workflow requires updating Sentry's `workflow_run.workflows` filter because it matches display names.

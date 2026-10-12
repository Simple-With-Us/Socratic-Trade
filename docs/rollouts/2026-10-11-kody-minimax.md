# Kody MiniMax Rollout

## Context & Objective

Jay requested that the Muse-backed autofix use MiniMax.  CTS-330 tracks the fleet rollout.

## Changes Made

- `.github/workflows/kody-fleet-autofix.yml`: select `MiniMax-M3` and update the displayed workflow name.
- `.github/workflows/sentry-ci-report.yml`: match the renamed workflow in the observer and its inventory comment.
- `AGENTS.md`: retire the Markdown effort ledgers in the protocol migration; Linear team `ST` is the sole effort board.
- `STATUS.md`: record verification and landing status.
- `PLAN.md`: record the model-selection approach and unchanged product roadmap.
- `docs/rollouts/2026-10-11-kody-minimax.md`: preserve this change and verification record.

## Decisions & Trade-offs

Use `https://api.minimax.io/v1` with the organization `MINIMAX_API_KEY`, and advance the reusable-workflow pin to the reviewed direct-provider implementation.  Preserve the enabled profile, budget, attempt cap, path restrictions, and shared per-PR concurrency group.  The change selects a model; it does not widen autofix access.

## Verification State

- `git diff --check`: passed.
- `actionlint -shellcheck= -pyflakes= .github/workflows/kody-fleet-autofix.yml .github/workflows/sentry-ci-report.yml`: passed.
- `npx --yes --package vitest@5.0.1 -- vitest run test/sentry-ci-report-workflows.test.ts --config <temporary-node-only-config>`: 3 tests passed.  The temporary config contains `export default { test: { environment: 'node' } };` and avoids requiring the app dependency tree for this workflow-only test.
- Shared helper synthetic canary: a live `MiniMax-M3` response from the direct OpenAI-compatible endpoint parsed into an edit and applied successfully.  Reproducible by running the pinned reusable workflow at `Simple-With-Us/congress-trading-shared@614ec3938cd7a86bc30a5a5b2367b29fabf40005` (the same ref `.github/workflows/kody-fleet-autofix.yml` calls), or by hitting the same endpoint with the same secret the workflow forwards (`secrets.MINIMAX_API_KEY` -> `MODEL_API_KEY`):
  ```bash
  curl -fsS -X POST "https://api.minimax.io/v1/chat/completions" \
    -H "Authorization: Bearer ${MINIMAX_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"<synthetic edit prompt>"}]}'
  ```
  The `<synthetic edit prompt>` and the "parse to unified-diff and apply" logic live in the pinned reusable workflow above.  The canary proves API compatibility, not a production Kody fix.
- Hosted CI and current-head Codex review remain required before merge.

## Next Steps & Blockers

Land PR #4523 after review and required checks clear.  Preserve existing tracking for autofix execution issues; this provider change alone does not prove every bot is healthy.

## Zero-Code Findings

Renaming a workflow requires updating Sentry's `workflow_run.workflows` filter because it matches display names.

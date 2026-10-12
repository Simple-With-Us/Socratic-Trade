# Claude Autofix Diagnostics

## Context And Objective

OPS-935 found Claude Code Autofix runs exhausting the 60-turn cap without retained tool-level evidence.  This caller opts into the shared sanitized diagnostics workflow so the next eligible run can be inspected.

## Changes Made

- `.github/workflows/claude-code-autofix.yml`: pin the reusable workflow to `3bff293b56adcc0367d3a91066938b2d4d5ebbc5`.
- `STATUS.md`, `PLAN.md`, and this rollout note: record scope, dependency, and verification.

The shared helper retains fixed tool names/categories, assistant-message indexes, counts, repeat groups, categorized errors, byte lengths, and aggregate duration/turn counts.  It excludes raw prompts, commands, arguments, paths, tool IDs, results, and model text.  Retention is seven days, bounded to 500 event rows and 256 KiB.  Hard runner termination may prevent upload; per-tool elapsed timestamps are unavailable.

## Decisions And Trade-offs

Keep the 60-turn cap, MiniMax model route, permissions, concurrency, and triggers unchanged.  The caller revision and its helper must be retained as ancestors of shared main, requiring a merge commit for shared PR #365.  Linear is the system of record; archived effort logs are not edited.

## Verification State

- `actionlint .github/workflows/claude-code-autofix.yml`: passed.
- `git diff --check`: passed.
- Shared tests: 12 Node tests and 463 package tests with coverage passed; typecheck and build passed.
- [Hosted synthetic validation](https://github.com/Simple-With-Us/congress-trading-shared/actions/runs/38207020098): passed, including artifact upload after a simulated failure.  The downloaded 580-byte JSON passed independent count, result, size, and private-content sentinel assertions.
- No paid provider call or old autofix run was dispatched for this change.  Application code is unchanged; current-head required CI remains the merge gate.

## Next Steps And Blockers

Merge [shared PR #365](https://github.com/Simple-With-Us/congress-trading-shared/pull/365) while preserving both pins.  Then merge this PR after current-head review and required checks pass.  OPS-935 remains open until a real eligible run provides useful diagnostics and the underlying turn exhaustion is addressed.

## Zero-Code Findings

The old logs cannot identify which tools consumed the exhausted budgets.  Diagnostics capture is not proof that the underlying autofix failure has been repaired.

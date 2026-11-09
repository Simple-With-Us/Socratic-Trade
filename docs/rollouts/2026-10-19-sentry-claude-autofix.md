# Sentry Claude Autofix Admission

## Context And Objective

ST-4562 follows the owner's request to let Sentry autofix run across the fleet.  The existing exact outer reviewer list and the CTS reusable's default actor list excluded Sentry/Seer.

## Changes Made

- `.github/workflows/claude-code-autofix.yml`: add `sentry` and `sentry[bot]` to the existing exact outer reviewer allowlist and an explicit inner `allowed_bots` override, preserving the six existing actor spellings.
- Include Sentry/Seer in the fixer prompt and its resolved-thread author list, still resolving only addressed or already-fixed findings.
- `STATUS.md` and `PLAN.md`: record this caller-only scope and verification state.

## Decisions And Trade-offs

Keep CTS reusable pin `31659885f58f08e129b6dc092f3493d7cdb74a11`; its actor input and immutable diagnostics/usage dependencies were fetched and verified.  Preserve review-submitted/dispatch triggers, same-repository restriction, shared concurrency, token permissions, explicit secrets, round cap, verification commands and existing merge instructions.  No broker, order, proposal, scheduler, CODEOWNERS or production configuration changes.  Other autofix workflows are unchanged to avoid enabling a second Sentry-triggered loop.

## Verification State

- Isolated YAML parsing and before/after contract assertions: passed.
- Actual caller-expression fixture evaluation: 15 cases passed, including both Sentry spellings, the six existing actors, fork rejection, unknown/impersonator/human rejection, unsupported events and manual dispatch.
- Pinned CTS reusable and diagnostics action at `58e3d9504e458b259d065789034f0d625e66324b`: fetched successfully; the action receives `inputs.allowed_bots`.
- `npm run lint`: not run locally in this connector-backed fixture lane; current-head hosted CI is required.
- `npx tsc --noEmit`: not run locally in this lane; current-head hosted CI is required.
- `npm test`: not run locally in this lane; current-head hosted CI is required.
- `npm run build`: not run locally in this lane; current-head hosted CI is required.
- Hosted gate receipts are available in [PR #4876 checks](https://github.com/Simple-With-Us/Socratic-Trade/pull/4876/checks).  These four application gates are distinct from the isolated workflow checks above.
- No live paid autofix dispatch was performed; runtime execution remains to be observed after review and merge.

## Next Steps And Blockers

Review the draft PR and its current-head required checks.  Keep auto-merge disabled for this change; no merge or deployment was requested by this lane.  Observe a genuine Sentry review on an eligible same-repository PR after landing.

## Zero-Code Findings

The workflow already retains the normal verify gate and never uses `--admin`.  CODEOWNERS and the money-path protections were inspected and left untouched.

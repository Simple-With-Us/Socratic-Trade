# Claude Autofix 120-Turn Cap

## Context And Objective

OPS-935 addresses Claude Code Autofix runs reaching the 60-turn ceiling.  This caller pins the shared 120-turn default and schema-2 sanitized operation diagnostics.

## Changes Made

- `.github/workflows/claude-code-autofix.yml`: pin shared reusable revision `99d372dcd7f600611c7b2b83a6f8eb2d31d6ecad`, the squash-merge commit of shared PR #368 on `main`.
- `PLAN.md` and `STATUS.md`: record scope, dependency, and current verification state.
- Shared PR [#368](https://github.com/Simple-With-Us/congress-trading-shared/pull/368) adds operation-category counts and error counters.  Raw commands remain excluded, and artifacts retain the existing seven-day, 500-event, 256-KiB limits.

## Decisions And Trade-offs

The reusable workflow raises its default from 60 to 120 turns and uses conservative fallback handling for ambiguous operation forms.  The 30-minute timeout, MiniMax route, caller prompt, secret, triggers, permissions, and shared concurrency stay unchanged.  Shared PR #368 squash-merged, so this caller pins that `main` commit instead of pre-merge revision `825f8ee008d6ce104107f2a7267c14d370e6013e`, which is not an ancestor of shared `main`.

## Verification State

- `actionlint .github/workflows/claude-code-autofix.yml`: passed.
- `git diff --check`: passed.
- `npm run lint`: passed in hosted [verify run 38337104537](https://github.com/Simple-With-Us/Socratic-Trade/actions/runs/38337104537) on the previous caller head (`825f8ee008d6ce104107f2a7267c14d370e6013e`).
- `npx tsc --noEmit`: passed in the same hosted run.
- `npm test`: passed in the same hosted run.
- `npm run build`: passed in the same hosted run.
- Local lint could not start because this lane had no installed dependencies; the hosted job installed from the lockfile and completed all four verification steps in the required order.
- Shared PR #368 recorded a successful run using 37 turns and 36 calls over 99 seconds with no errors; the resulting fix push was verified.  This run confirms a successful fix path but does not establish how all exhausted runs will behave.
- Caller PR CI and current-head Codex review remain required before merge.

## Next Steps And Blockers

Shared PR #368 is merged.  Merge this caller PR only after its current-head review and required checks pass.  Keep OPS-935 open until later eligible runs provide evidence about remaining exhaustion cases.

## Zero-Code Findings

The diagnostic counters summarize operation categories without retaining raw commands or results.  The successful run does not by itself prove the turn-exhaustion problem is resolved.

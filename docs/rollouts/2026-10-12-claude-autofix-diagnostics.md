# Claude Autofix 120-Turn Cap

## Context And Objective

OPS-935 addresses Claude Code Autofix runs reaching the 60-turn ceiling.  This caller pins the shared 120-turn default and schema-2 sanitized operation diagnostics.

## Changes Made

- `.github/workflows/claude-code-autofix.yml`: pin shared reusable revision `f6babc3ea5cae265a35e7e33fcb11403f9a9ba53`.
- `PLAN.md` and `STATUS.md`: record scope, dependency, and current verification state.
- Shared PR [#368](https://github.com/Simple-With-Us/congress-trading-shared/pull/368) adds operation-category counts and error counters.  Raw commands remain excluded, and artifacts retain the existing seven-day, 500-event, 256-KiB limits.

## Decisions And Trade-offs

The reusable workflow raises its default from 60 to 120 turns.  The 30-minute timeout, MiniMax route, caller prompt, secret, triggers, permissions, and shared concurrency stay unchanged.  This caller PR depends on shared PR #368 landing first.

## Verification State

- `actionlint .github/workflows/claude-code-autofix.yml`: passed.
- `git diff --check`: passed.
- Shared PR #368 recorded a successful run using 37 turns and 36 calls over 99 seconds with no errors; the resulting fix push was verified.  This run confirms a successful fix path but does not establish how all exhausted runs will behave.
- Caller PR CI and current-head Codex review remain required before merge.

## Next Steps And Blockers

Merge shared PR #368 first.  Then merge this caller PR only after its current-head review and required checks pass.  Keep OPS-935 open until later eligible runs provide evidence about remaining exhaustion cases.

## Zero-Code Findings

The diagnostic counters summarize operation categories without retaining raw commands or results.  The successful run does not by itself prove the turn-exhaustion problem is resolved.

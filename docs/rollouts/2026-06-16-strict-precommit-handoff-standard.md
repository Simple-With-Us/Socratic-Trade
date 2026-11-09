# 2026-06-16 - strict-precommit-handoff-standard

## Summary

- Deleted `docs/HANDOFF.md` to prevent split-brain documentation.
- Updated `AGENTS.md` to include a strict "Pre-Commit / Handoff Protocol" checklist that must be followed before every commit.

## Why

- A single `HANDOFF.md` file naturally overlaps with `STATUS.md` and gets overwritten, destroying historical context.
- We standardized on a stricter pre-commit protocol using only `STATUS.md` and chronological notes in `docs/rollouts/` instead.

## Files

- `AGENTS.md`
- `docs/HANDOFF.md` [DELETED]

## Verification

- `git status` confirms the file changes.

## Follow-ups

- Ensure all AI agents follow the Pre-Commit protocol defined in `AGENTS.md` moving forward.

# 2026-06-30 — Worktree ESLint Ignores

## Summary
Updated `eslint.config.mjs` to ignore `.claude/`, `.agents/`, `.tools/`, `**/worktrees/**`, and `scratch/` directories.

## Why
When running ESLint locally on the main workspace or sub-worktrees (e.g. during manual verification or pre-push hooks), the tool traversed hidden directories like `.claude/worktrees` and scanned internal build output inside `.next/` sub-directories, throwing over 19,000 type and import errors. Excluding these folders ensures local verification commands (`npm run lint`) check only active codebase files.

## Files
- `eslint.config.mjs` — added build/worktree directories to the ignores array.
- `STATUS.md` — updated status history.
- `docs/rollouts/2026-06-30-ci-worktree-eslint-ignores.md` — this rollout note.

## Verification
- `npm run lint` — passed with 0 errors and the pre-existing warning backlog (256 warnings).
- `npx tsc --noEmit` — passed cleanly.
- `npm test` — passed all 159 test files and 1546 test cases.

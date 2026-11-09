# 2026-06-21 — PR convention: ready by default, not draft

## Summary

Codified a pull-request convention in `AGENTS.md` (the canonical agent-instructions
file; `CLAUDE.md` symlinks to it):

1. Every branch intended to land on `main` gets a PR (long-lived integration/release
   branches, throwaway experiments, and stacked-PR bases excepted).
2. PRs open **ready for review by default — not as drafts**. This explicitly
   overrides the harness/tool default of creating draft PRs.
3. Draft is reserved for genuine work-in-progress, flagged in the PR description,
   and marked ready as soon as the work is complete and verified.
4. Added an auto-merge note: it needs the owner-only repo setting *Settings →
   General → Pull Requests → Allow auto-merge* AND a gating required check/review;
   with neither configured here, merge directly.

## Why

In this session, PRs were created as drafts (per the harness default), which blocked
GitHub auto-merge and forced an extra "mark ready" step before every merge. This repo
has no required CI checks and no branch protection, and the owner is effectively the
sole approver, so a draft adds friction without adding protection. The owner asked to
standardize on "always a PR, ready by default."

## Files

- `AGENTS.md` — new `## Pull requests` section (before `## Don't`).
- `STATUS.md` — Active Focus entry.
- `docs/rollouts/2026-06-21-pr-ready-by-default-convention.md` — this note.

## Verification

- Docs-only change; no source/tests touched. `npx tsc --noEmit` / `npm test` /
  `npm run build` are unaffected and were not re-run for a markdown-only edit.

## Follow-ups

- Optional: if the owner later wants true one-click auto-merge, enable the repo
  *Allow auto-merge* setting and add at least one required status check (even a
  trivial CI workflow) so auto-merge has a gate to wait on.

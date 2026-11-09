# 2026-06-25 — .gitignore: ignore GCP key + editor/IDE local files

## Summary
Trivial chore. Added three entries to `.gitignore` so local-only files never get committed:
- `gcp-sa-key.json` — a GCP Secret Manager service-account key (a **credential**; must never land in git).
- `.kiro/` — Kiro IDE folder.
- `*.code-workspace` — editor/IDE workspace files.

These were showing as uncommitted/untracked in the `main` integration worktree; ignoring them keeps the tree clean and prevents an accidental key commit.

## Files
- `.gitignore`

## Verification
tsc/test/build via `scripts/land.sh` (no code touched). Built in an isolated worktree off `origin/main`; landing via PR.

## Note
The `main` integration worktree had a local uncommitted `.gitignore` edit (the `gcp-sa-key.json` line) — once this merges, that local edit is redundant and can be discarded (`git checkout .gitignore` there).

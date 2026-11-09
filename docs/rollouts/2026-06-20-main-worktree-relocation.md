# 2026-06-20 — Main/integration worktree relocated to ~/Code/Agentic Trading

## Summary

The `main` (integration / review / merge) worktree moved on disk from the old
Documents checkout to `~/Code/Agentic Trading`. Re-mapped
every doc/script reference to the new path. Only the path strings changed — no
behavior, ports, branches, or the multi-worktree model itself changed.

## Why

The old Documents checkout directory no longer exists; the
canonical repo (the `.git` dir, branch `main`) now lives at
`~/Code/Agentic Trading`. Verified via `git worktree list`: this checkout is the
`main` worktree, and the old Documents path is gone. The new folder name also
drops the "Robinhood" prefix, consistent with the broker-neutral rename
(2026-06-20 `agent/antigravity`).

## What is NOT changed (deliberately)

- The per-agent worktrees still exist on disk and keep their paths/ports:
  `~/apps/trading-claude` (4100), `~/apps/trading-codex` (4101),
  `~/apps/trading-antigravity` (4102), and production `~/apps/trading-live`
  (4000). Verified all four still present via `git worktree list` + `ls`.
- Product-name references and folder-path references were treated separately so
  broker-neutral copy changes would not obscure the worktree relocation.
- `CLAUDE.md` is a symlink to `AGENTS.md`, so editing `AGENTS.md` updated both.

## Files

- `AGENTS.md` (worktree table row for `main`)
- `STATUS.md` (two topology references)
- `scripts/setup-agent-previews.sh` (header comment only; repo path is derived
  dynamically via `REPO="$(cd "$(dirname "$0")/.." && pwd)"`, so logic was
  already path-agnostic)
- `docs/rollouts/2026-06-16-kill-switch-confirmation.md` (`file://` link)
- `docs/rollouts/2026-06-20-alpaca-oauth-single-key.md` (six `file://` links)
- `docs/rollouts/2026-06-19-per-agent-live-previews.md` (integration table row)
- `docs/rollouts/2026-06-19-integration-scratch-cleanup.md` (absolute path in a
  verification step)
- `docs/rollouts/2026-06-20-main-worktree-relocation.md` (this note)

## Verification

- `git worktree list` — confirmed `/Users/jay/Code/Agentic Trading` is `main`;
  agent worktrees + `trading-live` still registered.
- `ls` on each old dir — old Documents checkout MISSING; all
  four `~/apps/trading-*` EXIST.
- `grep -rn "Documents/Robinhood\|Robinhood%20Agentic"` across `*.md`/`*.sh`/
  `*.json`/`*.ts`/`*.tsx` (excl. `node_modules`/`.next`) — 0 matches after edit.
- The relocated `file://` links resolve again (target source files exist at the
  same relative paths under the new folder).

## Follow-ups

- Committed in `c80a96d`, bundled with the `package.json` / `package-lock.json` rename and the
  Cursor review-cockpit integration. `main` is ahead of `origin/main`; **push** so the agent
  worktrees pick these doc edits up on their next `git merge origin/main`.
- If the `~/apps/README.md` host-deployment doc (lives on the deployment machine,
  not in this repo) references the old Documents path, update it there too.

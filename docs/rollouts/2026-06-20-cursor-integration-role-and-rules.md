# 2026-06-20 - cursor-integration-role-and-rules

## Summary

- Documented how Cursor fits alongside the three agentic tools (Claude Code, Codex,
  Antigravity) and added always-applied Cursor project rules.
- `AGENTS.md` (= `CLAUDE.md` symlink): the `main` integration row now names **Cursor** as the
  human editor, and a new "### Cursor: the human review cockpit (not a 4th agent lane)"
  subsection explains the role and guardrails.
- New `.cursor/rules/handoff.mdc` (frontmatter `alwaysApply: true`) mirrors the read-order, the
  pre-commit/handoff protocol, the verify order, and the hard guardrails so Cursor does not
  break the paper trail the other tools maintain.

## Why

- The repo already runs three *autonomous* agents in isolated worktrees/ports. A fourth
  parallel autonomous lane adds merge/preview/coordination overhead for little differentiation.
  Cursor's distinct value is the interactive human-in-the-loop seat (review, merge-conflict
  resolution, surgical hand-edits, in-editor debugging), which maps cleanly onto the existing
  human-owned `main` integration worktree.
- Cursor auto-loads `AGENTS.md` and `.cursor/rules/`, not `CLAUDE.md` by name; here `CLAUDE.md`
  is a symlink to `AGENTS.md`, so the handoff protocol is already in Cursor's context. The
  explicit `.cursor/rules` file is belt-and-suspenders plus Cursor-specific role framing.
- `origin/cursor/setup-dev-environment-73ae` and `-a574` already exist — Cursor's background-agent
  mode has run against this repo before and lands on `cursor/*` branches. The guidance treats
  those like any other `agent/*` branch.

## Files

- `AGENTS.md` (edited via the real file; `CLAUDE.md` is a symlink to it) — integration-row owner
  cell + new "Cursor: the human review cockpit" subsection.
- `.cursor/rules/handoff.mdc` — new, always-applied Cursor project rules.
- `STATUS.md` — Active Focus entry.
- `docs/rollouts/2026-06-20-cursor-integration-role-and-rules.md` — this note.

## Verification

- Docs/config only; no code, types, or tests changed. `npx tsc --noEmit` / `npm test` /
  `npm run build` are not required for this change and were not run.
- `ls -la CLAUDE.md` confirmed the `CLAUDE.md -> AGENTS.md` symlink.
- `git branch -a | grep cursor` confirmed the pre-existing `origin/cursor/*` branches.

## Follow-ups

- Committed in `c80a96d` — a concurrent integration commit on `main` swept this into the same
  commit as the worktree relocation and the `robinhood-agentic-dashboard` → `agentic-trading-dashboard`
  package rename. `main` is ahead of `origin/main`; **push** to propagate the Cursor role docs to
  the agent worktrees (they read `origin/main`).
- If Cursor is adopted as the standard review cockpit, consider a one-line mention in the
  README tooling section.

## Blockers

- None.

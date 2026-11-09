# 2026-06-21 — Git author identity rule: use the GitHub noreply email

## Summary

Codified a durable repo rule in `AGENTS.md` (= `CLAUDE.md`): every commit/push to the public GitHub
repo must use the owner's GitHub **noreply** email
(`12656028+jaywedgeworth22@users.noreply.github.com`), never the real email
(`mail@jaywedgeworth.com`).

## Why

GitHub's "block pushes that expose my email" protection was toggled on then off during the session;
with it off, a commit authored with the real email would publish it on the public repo. The owner
wants the email kept private regardless, and wants the rule + the config location documented so every
agent (Claude/Codex/Antigravity/Cursor) follows it and it can be restored if lost.

## Current state (already in effect)

- **Global** git email stays the owner's real email (`mail@jaywedgeworth.com`) — correct for their
  other repos, untouched.
- **This repo's** local `user.email` is set to the noreply address. With `extensions.worktreeConfig`
  off, that shared `.git/config` value applies to **all** linked worktrees (verified: the `main`
  integration tree and every `~/apps/trading-*` worktree resolve to the noreply email).

## What changed

- `AGENTS.md`: new "## Git author identity (GitHub email privacy)" section — the required noreply
  address, where the email is configured (global vs repo-local), and the rules/commands to verify,
  restore, and amend.

## Verification

- The repo-local `user.email` already resolves to the noreply address in all worktrees (`git config
  user.email` per worktree).
- Docs-only change; no code touched. Landed via `scripts/land.sh` (tsc/test/build gate + PR), and the
  PR commit itself uses the noreply email (proving the config works end-to-end past GitHub's check).

## Follow-ups

- The repo-local config is not tracked; document already notes how to restore it after a fresh clone
  or config reset.

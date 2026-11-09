# 2026-07-04 — Add the `agent/monet` preview lane (Monet) (Monet)

## Summary
Registers a fourth per-agent worktree/preview lane, **Monet**, analogous to the existing
`agent/claude` / `agent/codex` / `agent/antigravity` lanes, so the cloud Claude instance ("Monet")
has a first-class host lane. Branch `claude/register-monet-lane` (off `origin/main` @ `d8e1bdf`).

## What changed
- **`scripts/setup-agent-previews.sh`** — appended `monet` to `NAMES` and `4103` to `PORTS`
  (next free port after Antigravity's 4102), and added the Monet line to the header comment. The
  existing loop then materializes the lane idempotently: worktree `~/apps/trading-monet` on branch
  `agent/monet` (created from `origin/main` if absent), its own `node_modules`/`.env.local`, git
  hooks, and a PM2 `trading-monet` -> `next dev -p 4103`.
- **`AGENTS.md`** — added the `~/apps/trading-monet | agent/monet | 4103 | pm2 trading-monet |
  monet.jays.services | Claude Code (Monet, cloud lane)` row to the worktree table, and added Monet
  to the "Launch yourself in your own worktree dir" list.
- **`agent/monet` branch** — created on the remote from `main` (via the GitHub API; the git-over-HTTP
  push path was returning HTTP 503 at the time).

## Why
Owner request: make a new worktree/lane "formatted like `agent/monet`, analogous to the
`agent/claude` one." Monet is now a distinct fleet agent (cloud Claude), so it gets its own lane
with its own branch/port/preview, appended without renumbering the existing lanes (4100-4102 stay
put; Monet takes 4103).

## Verification
- `bash -n scripts/setup-agent-previews.sh` clean; `NAMES`/`PORTS` arrays are equal length (4 each).
- The pre-existing `->` arrows in the comment block are not `$VAR`-adjacent, so the bash-3.2 hazard
  the ASCII rule guards against is not present; the new comment line matches that existing style.
- `agent/monet` confirmed on the remote via the GitHub API create-branch response.

## Follow-ups
- The **public hostname** `monet.jays.services` is intended/documented but the Cloudflare tunnel
  route is host-local config (`~/apps/README.md` on the deploy machine) and is NOT set up from here —
  the owner adds the tunnel mapping when they want the public route live.
- Running `bash scripts/setup-agent-previews.sh` on the Mac materializes `~/apps/trading-monet` +
  the `trading-monet` PM2 preview on 4103.

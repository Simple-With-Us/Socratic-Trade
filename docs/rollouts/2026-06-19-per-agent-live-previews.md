# 2026-06-19 — Per-agent live-preview worktrees (supersedes the single committed preview)

## Why
The 2026-06-18 single `trading-preview` served *committed* `main` — but production (:4000)
already represents committed code, so a committed preview was redundant. What's wanted is a
**live in-progress** preview, and one *per agent* so Claude/Codex/Antigravity don't collide.
Investigation confirmed the collision was real: Codex (:3001) and Antigravity (:3002) were
both running `next dev` inside the *same* `~/Documents/...` worktree, sharing one `.next`.

## What
Each agent now gets its own git worktree + branch + PM2-hosted live `next dev` (HMR) + port,
fully isolated (`node_modules`/`.next`/`data/app.db`/`.env.local` per worktree):

| Agent | Worktree | Branch | Port | PM2 app |
|-------|----------|--------|------|---------|
| Claude | `~/apps/trading-claude` | `agent/claude` | 4100 | `trading-claude` (`next dev`) |
| Codex | `~/apps/trading-codex` | `agent/codex` | 4101 | `trading-codex` (`next dev`) |
| Antigravity | `~/apps/trading-antigravity` | `agent/antigravity` | 4102 | `trading-antigravity` (`next dev`) |
| (integration) | `~/Code/Agentic Trading` | `main` | — | merge/review only |
| production | `~/apps/trading-live` | release | 4000 | `trading` (`next start`) |

- `scripts/setup-agent-previews.sh` — NEW, idempotent bootstrap/repair of the three agent
  worktrees + PM2 dev servers (CoW-clones `node_modules`, copies `.env.local`, starts/restarts
  PM2, `pm2 save`).
- `scripts/refresh-preview.sh` — REMOVED (committed-preview era; live HMR needs no refresh).
- The single committed `~/apps/trading-preview` worktree + its PM2 app were removed.
- `AGENTS.md` "Hosting & dev servers" rewritten for the per-agent model; `STATUS.md` updated.

## Workflow for agents (in AGENTS.md)
- Launch each agent in its own worktree dir; edit only there on `agent/<name>`; live edits show
  at your port via HMR (no refresh).
- Commit on your branch, merge to `main` in the integration worktree (ff/PR); `git merge
  origin/main` to stay current.
- `npm run build` only affects your worktree; if it breaks your live preview (`ENOENT .next`),
  `pm2 restart trading-<you>`. Never affects others or production.
- A running port is NOT a work lock — coordinate via git + STATUS.md only.

## Verification
- All four PM2 apps online; `GET :4000/:4100/:4101/:4102 → 200`.
- Live-edit isolation proof: editing the `<title>` in `~/apps/trading-claude` showed
  "Agentic Trading Cockpit (LIVE-EDIT-TEST)" on **:4100** while **:4101** (codex worktree)
  stayed unchanged; reverted cleanly. Confirms per-worktree live HMR + isolation.
- `pm2 save` persisted the process list.

## Notes
- This session (Claude) performed the setup from the `main` integration worktree; future Claude
  sessions should launch in `~/apps/trading-claude`.
- Disk: `node_modules` is CoW-cloned (APFS `cp -c`), so the per-agent copies cost ~0 extra space
  until modified.

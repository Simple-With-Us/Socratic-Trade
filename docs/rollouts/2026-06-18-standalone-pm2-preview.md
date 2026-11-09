# 2026-06-18 — Standalone PM2 preview (port 4100), decoupled from agent sessions

## Why
Multiple AI tools (Claude Code, Codex, Antigravity) edit this repo. Previously each spun up a
session-bound `next dev` in the shared worktree, which (a) made one tool read a running dev port
as "another agent is working" and (b) collided on `.next` whenever any agent ran `npm run build`.
Production already runs decoupled (pm2 `next start` on :4000 from `~/apps/trading-live`). This adds
a matching, decoupled **preview** so browser checks no longer require an in-repo dev server.

## What
- **pm2 app `trading-preview`** → `next start -p 4100`, run from its own git worktree
  `~/apps/trading-preview` (detached on `main`). Independent `node_modules`, `.next`,
  `data/app.db`, and `.env.local`; never touched by an agent's build in the edit worktree.
- **`scripts/refresh-preview.sh [git-ref]`** (default `origin/main`): fetch → checkout ref →
  `npm ci` only if `package-lock.json` changed → `npm run build` → `pm2 restart trading-preview`.
- **AGENTS.md** "Hosting & dev servers" section rewritten: documents the three-worktree topology
  (edit / preview :4100 / production :4000), tells agents to prefer the hosted :4100 preview over
  their own dev servers, to never build inside the preview/production worktrees, and — the key
  rule for the original ask — **a running dev/preview port is NOT a work lock**; coordinate only
  via `git status`/`git log` and `STATUS.md`. Per-agent ephemeral dev lanes (Claude 3000 / Codex
  3001 / Antigravity 3002) are retained as optional for live HMR of uncommitted edits.

## Setup performed (on this machine)
- `git worktree add --detach ~/apps/trading-preview <main>`; copied `.env.local` from the edit
  worktree; provisioned `node_modules`; `npm run build`; `pm2 start … next -- start -p 4100
  --name trading-preview`; `pm2 save`.

## Files
- `scripts/refresh-preview.sh` (NEW), `AGENTS.md`, `STATUS.md`, this rollout note.

## Verification
- `GET http://localhost:4100/` → 200; serves the committed `main` build independent of the
  edit worktree. Production (:4000) and the topology doc unaffected.

## Notes
- The preview tracks committed `main` (not live uncommitted edits — those inherently live in the
  agent-edited worktree and can't be fully decoupled). Refresh after committing.
- `~/apps/README.md` (deployment-machine doc, outside the repo) is the place for tunnel/pm2
  ecosystem details if the preview should later be exposed publicly.

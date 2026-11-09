# 2026-07-06 — Coolify/Hetzner hosting migration + Cursor promoted to peer agent lane

## Summary

Stood up a self-hosted Coolify instance (open-source PaaS, MIT-style license, upstream
`coollabs/coolify`) on a Hetzner Cloud CX23 server (2 vCPU / 4GB RAM / 40GB SSD, x86 —
Hetzner's Ampere/ARM "CAX" line had no capacity available at signup time, and later even
the larger CX tiers and the "Regular Performance" 8GB tier were capacity-constrained, so
CX23 is what's actually running), reachable at the apex domain `jays.services`. Public
routing to the box is via a Cloudflare Tunnel (not a plain DNS `A` record — confirmed by
testing from this session, which can only reach outbound HTTPS:443, not arbitrary ports;
the tunnel's own Cloudflare-managed DNS entry is what actually resolves `jays.services`
today). Verified a Coolify API token (`Security > API Tokens`) authenticates successfully
against `https://jays.services/api/v1/*` (Coolify version 4.1.2, one server registered:
"localhost", i.e. the box itself, matching the "This Machine" single-server choice made
during Coolify's setup wizard).

Separately, corrected an outdated section of `AGENTS.md`: Cursor was documented as
"not a 4th agent lane," but the owner now runs Cursor's background/agent mode on
**DeepSeek**, producing work autonomously exactly like Claude Code/Codex/Antigravity do.
Cursor is now documented as a full peer lane (own branch, worktree, port, preview) while
retaining its existing human-review-seat role in the `main` integration worktree — the two
roles coexist, neither is subordinate to the other. Created the branches needed for this:
`agent/antigravity` (didn't exist before; only a topic branch `antigravity/socratic-webhooks`
did) and `agent/cursor` (new).

## Why

Owner was running 5+ separate AI coding tools/agents locally on a 16GB M5 MacBook Air and
hitting frequent crashes from memory pressure. Explored several offload options (Docker
locally — rejected, adds VM overhead rather than removing it; various cloud IaaS/PaaS
providers; Kubernetes — rejected as orchestration overkill for a handful of static
long-running services). Landed on: (1) use each coding tool's own native cloud/hosted mode
where available (Claude Code on the web, Cursor Cloud/background agents, Codex cloud) to
remove those processes from the laptop entirely, and (2) self-host Coolify on a single cheap
VM for anything needing a persistent, git-push-triggered preview server, replacing/
supplementing the local PM2-per-worktree setup documented in `AGENTS.md`.

The Cursor correction happened because, once asked to "move the app and all its branches"
onto the new Coolify box, the owner clarified Cursor should be treated as an equal
peer agent (it's DeepSeek-driven autonomous work, not just interactive human use), which
directly contradicted the existing `AGENTS.md` framing — fixed rather than left stale.

## Decisions made (owner-confirmed, worth recording since they reverse prior guidance)

- **Cursor is now a full peer agent lane**, not just the human review seat. This reverses
  the explicit "not a 4th agent lane" framing that was in `AGENTS.md` before this change.
- **Production (`socratictrade.com`) will be migrated onto the same CX23 box** as the
  preview-lane apps, despite the noisy-neighbor/reliability risk this was explicitly
  flagged with (a preview build's memory spike on a 4GB box could affect the live trading
  app). Owner chose "same box anyway" after the risk was explained. This is **not yet
  executed** — see Follow-ups.
- Coolify's own Backups feature (20% of server cost/mo) was declined for the preview-lane
  apps (fully reproducible from git + a fresh install script; not worth the recurring cost)
  but **must be enabled for the production app** once it's migrated, since production has
  real, non-reproducible state (`data/app.db`, live positions/orders).

## Files

- `AGENTS.md` (symlinked as `CLAUDE.md`) — hosting table gains an `agent/cursor` row
  (port 4104, `cursor.jays.services`), intro/launch-list mentions updated to include Cursor,
  the "running port is not a lock" port list corrected (was already missing 4103/monet), and
  the "Cursor: the human review cockpit (not a 4th agent lane)" section rewritten to
  "Cursor: peer agent lane (DeepSeek) *and* human review seat."
- `STATUS.md` — new dated entry at the top summarizing this work.
- `docs/EFFORT-LOG.md` — new "In Progress" row under the existing board format.
- `docs/rollouts/2026-07-06-coolify-migration.md` — this note.
- GitHub: new branches `agent/antigravity` and `agent/cursor`, both created from `main` HEAD
  (`7b5450fed36b3e288891cf45a633294b28513c11`) via the GitHub API, no file changes on them yet.

**Not yet done** (tracked as follow-ups below, not silently skipped):
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (the canonical branch-neutral live board) is a path
  on the owner's local Mac, not reachable from this cloud sandbox session. It still needs the
  same "Coolify migration" row mirrored into it by the owner or a session running on that
  machine — `docs/EFFORT-LOG.md` above is only the repo-tracked mirror half of that step.
- No application code changed. No Coolify "Application" resources have been created yet
  (project/repo connection, the 6 preview-lane deployments, or the production migration).

## Verification

- `curl` from this session to `https://jays.services` → HTTP 302 (redirect, expected —
  Coolify's login page). `https://jays.services/mcp` → HTTP 405 on a bare GET (expected;
  Coolify's native MCP endpoint expects POST, so this confirms the route exists).
- `curl -H "Authorization: Bearer $COOLIFY_API_TOKEN" https://jays.services/api/v1/version`
  → `4.1.2`.
- `curl -H "Authorization: Bearer $COOLIFY_API_TOKEN" https://jays.services/api/v1/servers`
  → one server, `is_reachable: true`, `is_usable: true`.
- `git log -3` / `git status` checked clean on `claude/llm-apps-m5-resource-optimization-n9w5ax`
  before editing docs.
- Did **not** run the repo's `npm run lint` / `tsc` / `npm test` / `npm run build` verify
  suite for this change — no application code was touched, only Markdown docs and external
  (Hetzner/Coolify/GitHub) infrastructure state.

## Follow-ups

- Create the Coolify "Socratic Trade" project, connect `jaywedgeworth22/socratic.trade`
  (handle private-repo auth), and deploy 6 applications: `main`, `agent/claude`,
  `agent/codex`, `agent/antigravity`, `agent/monet`, `agent/cursor` — each its own subdomain,
  each verified building/serving before calling it done.
- Migrate `socratictrade.com` production onto the same box: real secret transfer (broker +
  LLM API keys), a safe `data/app.db` migration/cutover plan with a rollback path, Coolify
  Backups enabled specifically for this app, and a DNS cutover done with care given this is
  a real-money trading application.
- Mirror this effort into `/Users/jay/apps/TRADING-EFFORT-LOG.md` (owner/local-session
  action — not reachable from this cloud session).
- Once the Coolify-hosted preview lanes are verified live, consider whether the local
  PM2/worktree hosting table in `AGENTS.md` should be retired or kept as a fallback — that's
  a separate decision from this note and hasn't been made yet.
- Hetzner capacity was constrained across every tier checked during setup (Ampere/CAX, then
  even mid-tier CX, then "Regular Performance" 8GB) — worth rechecking in a few days whether
  a larger tier has freed up, since the CX23 (4GB) is running production + 6 previews on
  swap-assisted headroom, not a comfortable margin.

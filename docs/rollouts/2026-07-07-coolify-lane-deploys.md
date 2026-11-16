# 2026-07-07 — Coolify preview lanes deployed (4/6 green) + 4GB box-wedge incident

Follow-up to `docs/rollouts/2026-07-06-coolify-migration.md` (which stood up the Coolify
instance on the Hetzner CX23 and recorded the Cursor peer-lane doc correction). This note
covers actually deploying the preview-lane applications and an OOM/wedge incident.

## Summary

Deployed the six Socratic Trade preview-lane applications on the self-hosted Coolify
instance (`jays.services`, Hetzner CX23, 2 vCPU / 4 GB / swap 8 GB). The apps are wired to
GitHub via a **GitHub App connection** (`source_id: 2`), NOT the SSH deploy key that the
earlier note generated — that deploy key is unused and can be deleted. Build pack is
nixpacks; each app exposes port 3000 and is served over `http://<host>` (Cloudflare Tunnel
terminates TLS at the edge and forwards to the box's Traefik on port 80, so the apps
intentionally do NOT use `https://`/Let's Encrypt on the origin — that would cause a
redirect loop and a cert challenge that can't validate through the tunnel).

**Result: 4 of 6 lanes are built and running; 2 are parked pending their branch owners.**

| Lane | Coolify app | Branch | Domain | State |
|------|-------------|--------|--------|-------|
| main / integration | socratic-trade-main | `main` | `trading.jays.services` | running (`✓ Ready` on :3000) |
| claude | socratic-trade-claude | `agent/claude` | `claude.jays.services` | running (Ready + DB migrated + scheduler up) |
| cursor | socratic-trade-cursor | `agent/cursor` | `cursor.jays.services` | running (`✓ Ready`) |
| antigravity | socratic-trade-antigravity | `agent/antigravity` | `antigravity.jays.services` | running (`✓ Ready`) |
| codex | socratic-trade-codex | `agent/codex` | `codex.jays.services` | exited — parked (see below) |
| monet | socratic-trade-monet | `agent/monet` | `monet.jays.services` | exited — parked (see below) |

## Domain / hostname scheme (owner decision this session)

- `trading.jays.services` = the **integration** preview (main lane), repointed off production.
- `socratictrade.com` = **production only** (unchanged; still the Mac `trading-live`).
- `trading-beta.jays.services` = **retired** (folds into `trading.jays.services`).
- `claude|codex|antigravity|monet|cursor.jays.services` = per-agent Coolify preview lanes.

The Coolify app FQDNs are already set to the above. The Cloudflare Tunnel routes still point
the agent/integration hostnames at the Mac PM2 previews and must be repointed by the owner
(cloudflared runs on the Mac; no cloud-session tool can edit the tunnel):
- `trading.jays.services`: `jay.local:4000` -> `http://91.98.44.8:80`
- delete `trading-beta.jays.services`
- `claude|cursor|antigravity.jays.services`: Mac `:41xx` -> `http://91.98.44.8:80`
- leave `codex`/`monet` on the Mac until those lanes build
- `socratictrade.com`: leave on `jay.local:4000` (production, untouched)

## Why the two parked lanes fail (stale branches — NOT a box problem)

- **agent/monet**: `package.json` pins `@jaywedgeworth22/congress-trading-shared@^1.2.0`
  from the **private GitHub Packages** registry -> `npm ci` fails with `401 Unauthorized`.
  It predates the 2026-07-04 switch (PR #444) to consuming the shared library from a **public
  git tag** (`github:jaywedgeworth22/congress-trading-shared#v1.4.1`), which `main` and all
  fresh-from-main lanes use and which needs no auth.
- **agent/codex**: a much older snapshot (`name: agentic-trading-dashboard`, Next 15, none of
  the current deps/scripts). Even building green it would serve a months-old app.

Owner decision: **leave both branches alone** — Codex and Monet will merge-forward their own
branches (normal `land.sh` hygiene). Do NOT reset/force-push them. Their Coolify previews stay
red until they sync to `main`.

## Incident: 4 GB box wedged under 2 concurrent builds

When all 5 remaining lanes were triggered at once, Coolify's default `concurrent_builds: 2`
ran two `next build`s simultaneously. Two concurrent Next.js builds plus the Coolify stack on
a 4 GB box drove it into sustained swap-thrash: the Coolify API, dashboard, and SSH all went
unresponsive (`jays.services` -> HTTP 000 for ~20+ min; `claude.jays.services` via the Mac
tunnel still 302, confirming the tunnel was fine and only the box was down). It did not
self-recover; the owner rebooted from the Hetzner console, after which Docker restarted the
already-built containers cleanly.

Mitigations applied:
- **`concurrent_builds` set to 1** on the server (persists across reboot) — builds now
  serialize; a single `next build` fits on 4 GB + swap (the claude canary proved this).
- Deploy/retry lanes **one at a time** going forward; never trigger multiple builds at once.

This is direct evidence for the noisy-neighbor risk of the planned production colocation
(task: migrate `socratictrade.com` onto this box): a pair of preview builds took the whole
box down. Revisit box sizing / isolation before putting production here.

## Files

- `docs/rollouts/2026-07-07-coolify-lane-deploys.md` (this note)
- `STATUS.md` — current-state entry
- `docs/EFFORT-LOG.md` — In Progress row updated
- `AGENTS.md` (symlinked `CLAUDE.md`) — Coolify migration note updated with the deployed state
  + hostname scheme + `concurrent_builds=1` caveat

## Verification

- Coolify API reachable post-reboot (`/api/v1/version` -> 200).
- Per-app checks: `status=running`, correct `git_branch`, correct `http://<host>` FQDN for
  all four green lanes; `codex`/`monet` `status=exited`.
- Runtime logs confirm each of the four booted Next.js: `✓ Ready` on `:3000` (claude also
  shows all 13 DB migrations applied and `[scheduler] started`).
- Full external HTTP verification against the real hostnames is pending the owner's tunnel
  repoint (the apps are only reachable via `*.jays.services` once the tunnel points at the
  box).

## Follow-ups

- Owner: repoint the Cloudflare Tunnel routes (table above); then confirm each URL serves.
- Codex/Monet: merge-forward `agent/codex` / `agent/monet` to `main` so their lanes build.
- Consider whether the local PM2/worktree hosting table in `AGENTS.md` is retired once the
  tunnel cutover is verified — not done here (cutover incomplete).
- Production migration remains not-started; reassess box sizing/isolation first.

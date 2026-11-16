# 2026-07-08 — ALL preview servers retired (owner decision, MONET)

## Summary

Owner (in-session): the `*.jays.services` preview servers are dead — "I never looked at
them anyways ever and they were even requiring Cloudflare Access which y'all could not
do, so y'all were making changes there for no reason." End state: **production only**
(`socratic-trade-prod` on the Coolify box = `socratictrade.com`). Coolify's PR-preview
feature was considered as an alternative and deliberately NOT enabled — it builds every
opened PR, and this fleet's PR volume already OOM-wedged (2026-07-07) and disk-filled
(2026-07-08) the 4 GB box. Revisit only on owner instruction (likely needs a bigger box).

## What was removed / stopped

- Coolify app `socratic-trade-preview` (`m9zy6do2hc0prhveva3vrcda`, trading.jays.services)
  — DELETED (recreate recipe remains in the 2026-07-07 rollout notes if ever needed).
- DNS (jays.services zone): `trading.jays.services` A, `main.jays.services` A (stray),
  and the `*.jays.services` wildcard A — deleted.
- Mac PM2: `trading-main`, `trading-claude`, `trading-codex` (`next dev` previews) —
  STOPPED + `pm2 save`. Worktrees untouched; agents run `npm run dev` locally instead.
- Mac PM2 `trading` + `litestream` (old prod) — **DELETED from pm2** (stronger than
  stopped: the stopped app was accidentally re-started TWICE tonight — 05:13Z via the
  deprecated publish script, 05:37Z by an unknown session — each time creating a live
  double-scheduler against production's broker accounts. `pm2 start trading` now has
  nothing to start). Rollback path is unchanged but now explicit:
  `pm2 start /Users/jay/apps/trading.config.cjs` (defines both apps) after stopping the
  Coolify prod app + restoring the tunnel CNAME.

## Kept

- `prod.jays.services` A record — an alias of PRODUCTION (same Coolify app), useful for
  origin testing without touching the apex. Not a preview.
- Tunnel CNAMEs for non-trading Mac services: `ag***-s**c`, `remote`, `ssh`.
- The per-agent worktrees and `agent/*` branches — the editing/landing workflow is
  unchanged; only the public preview hosting is gone.

## Files

- `AGENTS.md` — definitive retirement stanza (hosting section rewritten: production-only,
  do-not-recreate, PR-previews-not-enabled rationale); preview-freshness policy marked
  historical. (CLAUDE's open PR #1038 tears down lane docs but does NOT touch AGENTS.md,
  so this is the first definitive AGENTS.md recording.)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

- Coolify API: applications list shows only `socratic-trade-prod`; deletion request
  accepted for the preview app.
- DNS deletions returned success:true; pm2 list shows previews stopped and
  trading/litestream absent.
- Production untouched throughout: `/api/health` ok, scheduler ticking.

## Addendum (same night, owner-directed): preview DNS re-armed + admin host wired

- **`*.jays.services` wildcard A -> box RESTORED** (contradicting the deletion above —
  owner wants the ability to spin up temporary previews via Coolify later). Constraint
  recorded: preview hostnames must be ONE level under `jays.services`
  (e.g. `pr{{pr_id}}.jays.services`) — CF free Universal SSL does not cover two-level
  names. The Preview URL Template field is **UI-only** (API PATCH rejects
  `preview_url_template`); set it in the Coolify app UI when enabling previews.
  Previews remain NOT enabled; a preview-scoped `DB_BOOTSTRAP=fresh` env is pre-set on
  `socratic-trade-prod` so a future PR preview can never restore the prod DB and trade.
- **`admin.socratictrade.com` connected to production**: `ADMIN_HOST` +
  `AUTH_COOKIE_DOMAIN=.socratictrade.com` envs set (one-time re-login caused by cookie
  re-scope), domain added to the app FQDNs, DNS flipped tunnel-CNAME -> proxied A.
  Verified: `https://admin.socratictrade.com/` 307s into the /admin auth flow; apex
  unaffected; DB restore marker intact across the applying restart (no re-restore).

## Follow-ups

- CLAUDE's PR #1038 (docs: Coolify integration-only) is now doubly outdated (prod
  migrated + integration preview also retired) — owner/CLAUDE should update or close it.
- The Mac tunnel's public-hostname ingress rules for retired hostnames (claude/codex/
  antigravity/cursor/trading-beta -> localhost ports) are dead config; owner can prune
  them in the Cloudflare Zero Trust UI at leisure (harmless meanwhile).

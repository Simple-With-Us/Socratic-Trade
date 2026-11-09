# 2026-07-08 — Handoff: migrate `socratictrade.com` production → Coolify (for Monet)

## Context

The Coolify hosting migration (Hetzner CX23, 4 GB, behind `jays.services`) has been
**simplified**: the five per-agent preview lanes (claude/codex/antigravity/cursor/monet) were
**torn down** — they were full app instances nobody used, they OOM-wedged the 4 GB box, and for a
mostly-backend trading app a per-branch UI preview shows little. What remains on the box is the
single **integration** app (`main` branch), currently serving on the box (reachable at
`main.jays.services`; the `trading.jays.services` rename is optional/incomplete — see Open items).

The owner then asked: if the integration app runs fine on Coolify, why not move production there
too? This runbook is the answer. **It is a hand-off to Monet** because the migration needs
things this cloud session cannot touch: the Mac's live production DB, the Infisical secrets, and
the `pm2 trading` process. Monet runs in `~/apps/trading-monet` with Mac + Infisical access.

## The three things that make production ≠ a preview

1. **⚠️ Double-trading (the real hazard).** Production runs the autonomous scheduler that places
   *real orders*. If the box's production and the Mac's production are both live against the same
   broker accounts even briefly, they can double-place orders. The cutover MUST stop the Mac
   production before the box takes over. Exactly one scheduler live at any moment — Mac **or** box,
   never both.
2. **The database is irreplaceable.** `data/app.db` holds real users, positions, API keys,
   proposals. It needs a persistent Coolify volume, a clean migration from the Mac's live DB, and
   Litestream backups kept running. (Previews can be wiped and rebuilt; this cannot.)
3. **Real secrets + a real domain.** Broker keys, OAuth secrets, `OPENAI_API_KEY`, etc. (in
   Infisical) become Coolify env vars. `socratictrade.com` is a separate Cloudflare zone with its
   own TLS; OAuth redirect URIs already point at `socratictrade.com` and stay unchanged (only the
   origin moves).

## Prerequisite decision — box sizing (do this FIRST)

The 4 GB box already wedged under two concurrent `next build`s (see
`docs/rollouts/2026-07-07-coolify-lane-deploys.md`). For a live-trading app, a redeploy-induced
wedge = stalled scheduler / missed orders / dashboard down. **Resize the Hetzner box to ≥8 GB
first** (in-place resize + reboot) or run production on its own box. If you skip this, the owner
is accepting that a production redeploy can disrupt live trading. `concurrent_builds=1` is already
set on the box, which helps but does not eliminate the risk.

## Runbook

**Stage 0 — build it, no cutover**
1. New Coolify app `socratic-trade-prod` from the repo (production branch), nixpacks, port 3000,
   domain `http://socratictrade.com` — do NOT point DNS yet. Use the existing GitHub App source
   (the old SSH deploy key was deleted; it is unused).
2. Attach a **persistent volume** for the DB directory; set `DATABASE_URL=file:/app/data/app.db`
   (match the app's expected path). Without a persistent volume the DB is wiped on every redeploy.
3. Set all prod **secrets** as Coolify env vars from Infisical: `OPENAI_API_KEY`, `ALPACA_*`,
   `ROBINHOOD_*`, Google/GitHub OAuth id+secret, `NEXTAUTH_SECRET`, `NEXTAUTH_URL=https://socratictrade.com`,
   `SENTRY_DSN`, `OPS_DIAGNOSTIC_TOKEN`, and any provider keys.
4. Deploy; confirm it boots (`✓ Ready` on :3000) on a fresh/empty DB. Do not wire it to real
   trading yet.

**Stage 1 — migrate the DB**
5. On the Mac, take a **consistent** copy (not a live `cp`):
   `sqlite3 ~/apps/trading-live/data/app.db ".backup /tmp/prod.db"`.
6. `scp /tmp/prod.db` to the box's persistent-volume path; restart the prod app; verify real
   users/positions appear.
7. Configure Litestream on the box to keep replicating/backing up (mirror the Mac's litestream
   config/target).

**Stage 2 — backups**
8. Enable Coolify Backups for the volume **and/or** confirm Litestream is replicating. Do NOT skip
   — this is production.

**Stage 3 — cutover (do it while the market is closed)**
9. **⚠️ STOP the Mac production FIRST:** `pm2 stop trading` on the Mac; confirm its scheduler is
   down (no orders from the Mac).
10. Point `socratictrade.com` DNS → the box; confirm TLS resolves.
11. Verify: `/api/health` 200, OAuth login works, positions/accounts correct, and the scheduler is
    running **exactly once** (box only). Run the money-path sanity checks.

**Rollback:** point `socratictrade.com` back to the Mac and `pm2 start trading`. If any trades
happened on the box after cutover, reconcile them — the Mac DB is only the pre-cutover snapshot.

## Non-negotiables

- Exactly **one** scheduler live at any moment (Mac or box, never both) — double-trading is real
  money lost.
- Back up the DB before migrating; it is irreplaceable.
- Size the box up first (≥8 GB) or explicitly accept the wedge-during-trading risk.

## Open items (integration side, not blocking production)

- The `trading.jays.services` rename of the integration app is incomplete: a redeploy to apply the
  `trading.jays.services` Traefik label is stuck in Coolify's build queue (a leftover from the
  post-wedge reboot). The integration app works today at `main.jays.services`. Decide whether to
  chase the rename (needs the queue unstuck) or keep `main.jays.services`.
- Five dangling `*.jays.services` DNS records (claude/cursor/antigravity/codex/monet) plus a
  `*.coolify.jays.services` wildcard from the earlier setup are cosmetic (they 404 via the
  `*.jays.services` wildcard) and pending deletion.

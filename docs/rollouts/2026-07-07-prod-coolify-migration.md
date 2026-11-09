# 2026-07-07 — Migrate PRODUCTION socratictrade.com to the Coolify box (MONET, owner-directed)

Owner asked in-session: "can you migrate the production site to coolify server at
jays.services?" This note records the design, the repo additions, and (updated as it
happens) the cutover. Follow-up to `docs/rollouts/2026-07-07-coolify-lane-deploys.md`,
which migrated the preview lanes and explicitly deferred production.

## Summary

Production moves from the Mac (`~/apps/trading-live`, pm2 `trading` -> `next start` :4000,
served via Cloudflare Tunnel) to a new Coolify application on the Hetzner box
(`91.98.44.8`, Coolify v4.1.2 at `https://jays.services`). New app
`socratic-trade-prod`: GitHub App source, branch `main`, nixpacks, port 3000,
**auto-deploy OFF** (production releases remain a deliberate owner/agent-run step, same as
the old `~/apps/trading-publish.sh` model — merging to `main` still only auto-deploys the
integration preview).

Key design points:

- **Secrets stay in Infisical.** The app boots via `scripts/coolify-prod-start.sh`
  (new), which installs pinned `infisical` CLI **0.43.98** + `litestream` **0.5.14**
  binaries onto the persistent volume, then self-wraps in `scripts/infisical-run.mjs`
  (same runner production used on the Mac; `REQUIRE_SECRETS_MANAGER` stays enforced).
  Coolify env holds only the Infisical universal-auth identity (`INFISICAL_*`, values
  copied from the Mac's pm2 `trading` env — note `INFISICAL_ENV=prod`, not
  `production`) plus `NIXPACKS_NODE_VERSION=24`, `NIXPACKS_PKGS="gnutar gzip"`,
  and the `DB_BOOTSTRAP` gate.
- **DB migrates via the existing litestream replica.** The Mac's litestream sidecar has
  been replicating `data/app.db` (113 MB) to R2 (`trading-live/app.db` path). The new
  `litestream.coolify.yml` points at the same replica with the container path
  `/app/data/app.db`. At cutover the container restores from that replica (one-time,
  marker-file-guarded), then runs `litestream replicate -exec "npm run start"` so
  PITR backup continuity is preserved on the box. Litestream versions are pinned equal
  (0.5.14 wrote the replica; 0.5.14 restores it — LTX format compatibility).
- **Double-scheduler safety.** `DB_BOOTSTRAP=fresh` (initial state) starts the app on an
  empty DB: no users, no broker accounts, scheduler cannot place orders — safe to build
  and verify while Mac production is still live. Only after pm2 `trading` + `litestream`
  are stopped on the Mac is `DB_BOOTSTRAP` flipped to `live` (runtime env change +
  container restart, no rebuild) to restore the real DB. This matters doubly because
  `main` (#1036) flipped `ALLOW_LIVE_TRADING` to opt-OUT, and the Infisical prod env does
  not set it — the connected Robinhood live account trades on its environment as soon as
  a scheduler runs against the restored DB (verified: current Mac prod already runs
  `e73c66a4` with the same env, so this is parity, not a behavior change).
- **Persistent volume** mounted at `/app/data` (SQLite DB + `.bin` tool cache +
  `logos/` cache re-populates on demand).
- **Domains/DNS.** App FQDNs: `http://socratictrade.com` + `http://prod.jays.services`
  (origin serves HTTP; Cloudflare proxies terminate TLS at the edge — same scheme as the
  preview lanes). `prod.jays.services` gets a proxied A record to `91.98.44.8` first for
  verification; cutover then flips `socratictrade.com` from its tunnel CNAME
  (`6b807051-....cfargotunnel.com`) to the same proxied A record.
  `admin.socratictrade.com` currently 404s through the tunnel (no ingress rule) and is
  left untouched.

## Rollback

Restore the `socratictrade.com` proxied CNAME to `6b807051-38ab-4062-8d52-0cddf1d66657.cfargotunnel.com`,
then on the Mac: `pm2 start trading litestream` (worktree `~/apps/trading-live` is left
fully intact, DB included). Any writes made on the box after cutover are lost to the Mac
copy but survive in the R2 replica (the box replicates to the same path).

## Files

- `scripts/coolify-prod-start.sh` (new) — phase-1 binary bootstrap + phase-2
  `DB_BOOTSTRAP` gate described above. ASCII-only per repo shell-script rule.
- `litestream.coolify.yml` (new) — container-path litestream config, env-interpolated,
  no secrets.
- `docs/rollouts/2026-07-07-prod-coolify-migration.md` (this note)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `AGENTS.md` — migration state recorded.

## Verification

- Pre-work: confirmed prod pm2 env (`INFISICAL_ENV=prod`), `DATABASE_URL=file:./data/app.db`
  (relative — container-safe), `LITESTREAM_S3_*` present in the injected env (5 keys),
  `ALLOW_LIVE_TRADING` unset, Mac litestream binary 0.5.14, release-asset URLs for both
  pinned binaries return 200.
- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` run before landing
  (this PR adds only shell/yaml/docs, but the verify gate runs regardless).
- Cutover verification (RESULTS APPENDED BELOW WHEN DONE): app `running` +
  `✓ Ready` in runtime logs, restore marker written, `https://socratictrade.com` serves
  200 with real data, `/api/health` ok, scheduler ticking.

## Status / cutover log

- 2026-07-07 ~23:00 CDT — plan + repo additions written; PR #1039 merged (verify green).
- Coolify app `socratic-trade-prod` created: uuid `m1os7ijf31bg3fanil152e4b`, persistent
  volume `prod-app-data` -> `/app/data` (storage API type=`persistent`), 13 envs via
  `PATCH /envs/bulk` (Infisical identity runtime-only `is_buildtime:false`; NIXPACKS_*
  buildtime), `is_auto_deploy_enabled:false`.
- **Found + fixed a pre-existing outage:** `trading.jays.services` (integration preview)
  had been 503 at the edge since the tunnel->direct-A DNS switch. Cause: app FQDN was
  `http://...` so Coolify/Traefik only created an :80 router, while both Cloudflare zones
  run SSL mode **full** (edge connects origin :443). Fix (and the scheme production now
  uses): set the app domain to `https://...` — Traefik then serves :443 (self-signed
  default cert, acceptable to "full") — plus restart. The AGENTS.md "apps served over
  http://" note described the abandoned tunnel transport and is superseded.
- 2026-07-07 23:12 CDT — first deploy (fresh mode) built + booted clean: binaries
  installed (litestream 0.5.14, infisical CLI 0.43.98), 51 shared + 94 app secrets
  injected, migrations applied to the empty volume DB, scheduler started,
  `prod.jays.services` 307 at edge, `/api/health` ok.
- 2026-07-07 23:13:21 CDT — `pm2 stop trading`; WAL quiesced 20s; `pm2 stop litestream`;
  `pm2 save` (both stay STOPPED in the saved state — rollback standby).
- 23:14 CDT — `DB_BOOTSTRAP=live` + container restart: fresh DB moved aside
  (`*.pre-restore-*` on the volume), litestream restore from R2 completed, replicate
  resumed to the same bucket/path (`txid.replica == txid.db` within 2s), app Ready,
  `[scheduler] user local has autoResumeOnBoot enabled` — the restored DB is the real
  production DB and autonomy resumed exactly as it would on a Mac reboot.
- 23:15 CDT — DNS: `socratictrade.com` CNAME(tunnel `6b807051-...`) -> **A `91.98.44.8`
  proxied** (record id `f43f1023f8a63d04aedafd39616aab9d`; old value in the record
  comment for rollback).
- 23:16-23:18 CDT — verification: edge 307, `/login` 200, `/api/health` ok with
  db ok + scheduler ticking (age cycled 14s->55s->16s over four 20s polls, matching the
  60s tick), dataProvider tier cache timestamps from 2026-07-07 08:49 (i.e. restored
  production data, not a fresh DB), `pineconeConfigured: true` (real secrets), container
  status stable (no restart loop). **PRODUCTION IS NOW SERVED FROM THE COOLIFY BOX.**

## Incident: post-cutover double-run (2026-07-08 05:13-05:19Z, resolved)

A parallel MONET session, unaware of the completed cutover, ran the (now-deprecated)
`~/apps/trading-publish.sh` ~1h after cutover — restarting Mac pm2 `trading` and creating
a ~5-minute **double-scheduler** window (Mac + box, same broker accounts, same DB state).
Detected via its #ag***-s**c post; Mac `trading` re-stopped + `pm2 save` at 05:19Z.
Damage scan of the Mac DB for the window: **0 proposals, 0 fills**; the only trace is 9
`synthetic_stop_error` audit events — the Mac's attempts to (re)place the MU synthetic
stop were rejected by Alpaca with `422 client_order_id must be unique`, i.e. the
**deterministic client-order-id dedupe held** and the box's orders won. Litestream was
NOT restarted (no replica interference). Markets were closed throughout.

Hardening applied: `~/apps/trading-publish.sh` now **refuses to run** unless
`FORCE_MAC_PROD_ROLLBACK=1` is set, with a pointer to this note (host-side file, not in
repo). Lesson: a deprecated-in-docs deploy path is not deprecated enough while it remains
executable — parallel sessions may act on pre-migration context.

## Incident: box disk-full (2026-07-08 ~05:20Z-05:35Z, RESOLVED)

Resolution: Coolify API returned 200 (v4.1.2) at ~05:35Z after the owner got a shell on
the box (disk freed); prod app stayed healthy throughout — the app container and Traefik
never stopped serving. Fleet merge/deploy freeze lifted. Original report follows.


Reported by the parallel session and confirmed: Coolify API/dashboard 500s while the
prod app keeps serving (health ok, scheduler ticking). Likely cause: tonight's repeated
nixpacks builds (integration-preview rebuilds on each merge to `main` + the prod build)
filled the box disk with images/build cache. **Until resolved: avoid merging to `main`**
(each merge triggers an integration-preview build on the box) and do not trigger
deploys. Remediation needs box shell (owner: Hetzner console / SSH):
`docker builder prune -af && docker image prune -af` (keeps running containers), then
consider enabling Coolify's scheduled Docker cleanup with a tighter threshold.
If the box degrades before that: rollback path = stop Coolify app + restore apex CNAME
to the tunnel + `FORCE_MAC_PROD_ROLLBACK=1 bash ~/apps/trading-publish.sh` (or just
`pm2 start trading litestream` — worktree is current at `2d113054`).

## Addendum: Coolify control plane off the Mac (2026-07-08, owner-directed)

`jays.services` (Coolify dashboard/API) was still a tunnel CNAME — i.e. reaching the
Coolify control plane required the Mac's cloudflared to be up, even though production
itself no longer needs the Mac. Owner said to remove that hop: apex flipped to a proxied
A `91.98.44.8` (record `2ba989947869f0aae5cf1eb7401a2910`; old tunnel target in the
record comment). Verified pre/post parity direct-vs-edge (401 unauth / 500 authed — the
500s are the open disk-full incident, identical on both paths, so routing is proven).
MX/TXT records untouched (iCloud mail unaffected). The Mac tunnel's
`jays.services -> 91.98.44.8:8000` ingress rule is now unused (kept as rollback).

## Follow-ups

- Consider `limits_memory` on the prod app container (box is 4 GB; builds already
  serialize via `concurrent_builds=1`, runtime caps not yet set).
- Decommission plan for the Mac lane (pm2 delete + tunnel route removal) only after a
  soak period — keep as rollback target for now. `~/apps/trading-publish.sh` is now a
  DEPRECATED deploy path (it would build+restart the stopped pm2 lane, not production);
  production release = trigger a Coolify deploy of `socratic-trade-prod`.
- Empirically confirm `is_auto_deploy_enabled:false` held (next merge to `main` must NOT
  queue a `socratic-trade-prod` deployment; the integration preview rebuilding is fine).
- `[congress-stream] no subscription configured` warnings appeared on the fresh-DB boot;
  confirm they cleared (or match Mac behavior) on the restored DB.
- `admin.socratictrade.com` still CNAMEs the tunnel and 404s (no ingress rule) — same
  behavior as before; decide whether to delete or repoint later.
- Rotate/trim the old `app.db.backup-*` files on the Mac (not migrated).
- Preview lanes other than `trading.jays.services` (claude/cursor/antigravity DNS names)
  may still have the same http://-FQDN-vs-SSL-full 503 — their Coolify apps were
  consolidated/removed, so their DNS records now point at a box with no matching router.
  Owners should recheck when re-standing them up (use https:// FQDNs).

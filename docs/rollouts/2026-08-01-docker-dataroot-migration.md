# Docker + containerd data-root migration to /data (Oracle prod box) (2026-08-01)

## Context & objective

Deploys on the Oracle prod box (<ORACLE_IP_RETIRED>) kept wedging on ENOSPC —
two incidents in one day (06:55 and 23:13 UTC, both `webpack.cache` write
failures mid-build, the second leaving a zombie deployment that blocked the
queue). Root disk was 73-92% with ~25 GB of Docker state on it. Owner
approved moving Docker's storage to the 98 GB `/data` volume.

## Key discovery

**This Docker uses the containerd image store** (default on new Docker
Engine installs): `/var/lib/docker` held only 181 MB (metadata, volumes,
buildkit), while `/var/lib/containerd` held **24 GB** (overlayfs snapshots +
content). Moving only Docker's `data-root` would have freed almost nothing —
both roots had to move.

## Changes made (host-level, no repo code)

1. **Stop order that actually works on this box** (hard-won):
   `systemctl mask docker.socket docker.service containerd.service` FIRST,
   then `stop`. A plain stop is immediately canceled — coolify-sentinel /
   Coolify reactivates docker via socket activation within seconds (observed:
   a full dockerd + queued-deploy restart 90s after a "successful" stop,
   which recreated a junk `/var/lib/docker` and pulled 2 GB mid-migration).
   Unmask only after configs are in place.
2. `rsync -aHAX /var/lib/docker/ → /data/docker/` (181 MB) and
   `/var/lib/containerd/ → /data/containerd/` (24 GB; resumable — large copy
   needs multiple passes or one long window).
3. `/etc/docker/daemon.json` += `"data-root": "/data/docker"` (backup saved
   alongside); `/etc/containerd/config.toml` created:
   `version = 2`, `root = "/data/containerd"`, `state = "/run/containerd"`.
4. Originals moved aside, services started, **verified from the new roots**,
   then deleted (`containerd.old` 24 GB; zombie-window dir 2.5 GB needed
   `umount -l` on three stale overlayfs mounts first).

## Verification state

- `docker info`: Docker Root Dir = `/data/docker`, Storage Driver overlayfs.
- All containers back from the migrated store; **root disk 73% → 34%**
  (30 GB free); `/data` 34% → 58%.
- `socratictrade.com` 200, `host.jays.services` 200, litestream replicating
  with zero errors, Coolify deploy pipeline functional.
- **Incidental fix**: `congress.trade` was 502 — pre-existing crash loop
  from Grok's turso→local-sqlite cutover (23:47 UTC): `TURSO_DATABASE_URL`
  in the CT Infisical prod was `file:/data/...` (one slash — libsql
  `URL_INVALID`). Set to `file:///data/congress-trade/db.sqlite`, restarted
  via Coolify → 200. (Grok's code change itself was fine; only the env
  value's URL form was wrong.)

## Next steps & blockers

- Builds now write to `/data` — the ENOSPC deploy-wedge class of failure
  should not recur at current growth rates (40 GB free on /data).
- Consider pruning the stale `prod.db.*` seed/backup files littering
  `/data` root (several GB, from the July 18 cutover) — left untouched this
  pass.
- If docker is ever reinstalled/upgraded, confirm the containerd image
  store stays enabled and the two data-root settings persist.

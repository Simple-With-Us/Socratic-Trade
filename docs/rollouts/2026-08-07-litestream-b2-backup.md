# 2026-08-07 — Litestream active replica → Backblaze B2

## Context & Objective

Production SQLite continuous backup was **paused** (R2 free-tier kill-switch marker
since ~2026-08-04 / Hetzner cutover) so the live DB had no offsite PITR. Owner: wire
**complete** backups to Backblaze B2, clean spare/corrupt host DB copies, and **leave
Cloudflare R2 objects as historic** until B2 is proven (do not delete R2 data).

## Changes Made

### Config / boot

- `litestream.coolify.yml` — active S3 replica is B2-oriented: `region: ${AWS_REGION}`,
  `force-path-style: true`, `sync-interval: 60s`, snapshot retention **168h** (7d).
  Path remains `trading-live/app.db`.
- `scripts/coolify-prod-start.sh` — R2 kill-switch marker only skips litestream when
  `AWS_S3_ENDPOINT` is Cloudflare R2. B2/other endpoints **ignore** the marker so
  historic free-tier pressure cannot pause real backups.
- `src/lib/r2-usage.ts` — `isLitestreamReplicaCloudflareR2()`; auto-disable (exit 41)
  only when the active replica is still R2. Monitor/alerts for R2 free-tier remain.
- Tests: R2 vs B2 endpoint detection + B2 does not write kill-switch marker.
- `.env.example` — documents B2 production values + optional `AWS_R2_HISTORIC_*`.

### Secrets (Infisical ST prod — not in git)

- Preserved prior R2 credentials as `AWS_R2_HISTORIC_*` (bucket/endpoint/region/keys).
- Active litestream `AWS_*` now B2 scoped key `fleet-socratic-backup` →
  bucket `jays-socratic-trade-eu`, endpoint `https://s3.eu-central-003.backblazeb2.com`,
  region `eu-central-003`.

### Host volume (`<ST_COOLIFY_APP_UUID>-prod-app-data`)

After live `PRAGMA integrity_check = ok`, removed forensic cutover copies (~9 GB):

- `app.db.corrupt-*`, `app.db.l9-*`, `app.db.prev-*`, `app.db.repaired-*`,
  `app.db.safety`, `app.db.before-repair-*`
- One-off restore probe scripts (`try-*`, `probe-*`, `list-r2.mjs`, …)

**Kept:** live `app.db` / `-wal` / `-shm`, history/logos/sec-fills, litestream socket
dir. **R2 bucket objects:** untouched.

### Files touched (repo)

- `litestream.coolify.yml`
- `scripts/coolify-prod-start.sh`
- `src/lib/r2-usage.ts`
- `test/r2-usage.test.ts`
- `.env.example`
- `docs/litestream.md` (prod B2 note)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`, `/Users/jay/apps/COOLIFY.md` (ops)

## Decisions & Trade-offs

- **Single active replica** (Litestream 0.5.x): B2 only. R2 is freeze/historic, not dual-write.
- **Kill-switch stays in code** for any future R2 re-point, but is inert for B2.
- **Retention 7d on B2** (was 24h free-tier survival on R2) — paid B2 capacity.
- **Do not delete R2** until owner confirms restore-from-B2 + soak.

## Verification State

```bash
npx vitest run test/r2-usage.test.ts   # 38 passed
# Infisical lengths: AWS_S3_BUCKET_NAME=22, ENDPOINT=41, REGION=14, KEY=25, SECRET=31
# Host: integrity ok; spare DB files removed; volume size drop ~9G expected
# Post-deploy: container logs "replicating" + B2 list under trading-live/app.db/
```

## Next Steps & Blockers

1. Merge this branch → auto-deploy pulls new yml + Infisical B2 env on boot.
2. Confirm first LTX/snapshot in `jays-socratic-trade-eu` (Usage Monitor B2 adapter or
   `litestream ltx` in container).
3. Optional restore drill to scratch path from B2; then owner may delete R2 historic.
4. Clear leftover `.litestream-r2-disabled` marker when convenient (cosmetic once on B2).

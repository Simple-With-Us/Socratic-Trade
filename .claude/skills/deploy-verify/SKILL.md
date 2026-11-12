---
name: deploy-verify
description: Verify production after a deploy fires (auto-deploy on merge to main since 2026-07-10; no manual claims/triggers). Checks Coolify status, app health, backup continuity, and known failure classes.
---

# Deploy Verification

Every merge to `main` auto-deploys via Coolify webhook (mechanism and rollback: `docs/rollouts/2026-07-10-auto-deploy-on.md`; do not post manual deploy claims or trigger deploys yourself -- see Canon). Verify post-deploy using this procedure.

## 1. App Health (start here -- always reachable)

```bash
curl -s https://socratictrade.com/api/health | jq '.ok, .checks.db, .checks.schedulerAgeSeconds'
```

Fields are nested under `.checks` (camelCase), not top-level. Expect: `ok: true`, `db: "ok"`, `schedulerAgeSeconds < 300` (scheduler ticks every 60s). Root redirect:

```bash
curl -sI https://socratictrade.com | head -1
```

Expect `HTTP/2 307` (redirect to `/login`) or `200` after the chain resolves.

## 2. Deployment Status (Coolify API)

The Coolify REST API at `host.jays.services` sits behind a Cloudflare IP allowlist that has historically 403'd everything except GitHub's webhook ranges -- it is normally **unreachable from an agent's own machine** (confirmed: `is_auto_deploy_enabled` had to be flipped via box SSH, not the API, because of this). Try it, but do not treat a 403 here as a production problem:

```bash
COOLIFY_TOKEN="$(fleet-secrets get COOLIFY_SERVER_STATS)"   # read-only stats token; never echo it
curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" \
  https://host.jays.services/api/v1/applications \
  | jq '.[] | select(.uuid == "m1os7ijf31bg3fanil152e4b") |
    {id, name, latest_deployment: .latest_deployment |
    {status, commit_sha, is_webhook}}'
```

If it 403s (expected from most sessions), fall back to SSH and check the box directly (see section 5).

Expect: `status: "finished"`, `commit_sha` matches `git rev-parse origin/main`, `is_webhook: true` (confirms the webhook fired rather than a manual trigger).

**Zombie alert:** a deployment stuck `in_progress` blocks the queue (`concurrent_builds=1`) -- this has happened before after a mid-clone GitHub blip. Post `#Work-In-Progress` immediately with the deployment id if you can confirm it from the box.

**Silent-freeze watch (#2545):** GitHub webhook 200s + a healthy `/api/health` on an
*old* sha is the 2026-08-06 class (Coolify SSH exec stream exit 255 under shared-box
load). Do not wait for a human to notice. The standing cron is
`.github/workflows/deploy-freshness.yml` (`scripts/alert-deploy-freshness.sh`).
A failed run means the oldest undeployed main commit is older than 1h --
investigate the queue; do not hand-trigger. CT OCR isolation (dry-run only unless
the owner latches apply) is `scripts/isolate-shared-box-batch.sh` -- default
**5.0 of 8 vCPUs**, the highest advisable cap that still leaves 3 cores for
Coolify/ST/UM.

## 3. Backup Continuity (Litestream)

Litestream runs IN the Coolify container and IS the DB backup path. The `/api/health` payload already reports its state -- prefer this over trying to inspect R2 directly:

```bash
curl -s https://socratictrade.com/api/health \
  | jq '.checks.storage | {litestreamAgeSeconds, litestreamStatus, litestreamState, litestreamDegradedReasons, litestreamTierCoverage, litestreamCompactionLogFailureCount}'
```

Expect `litestreamAgeSeconds` small and steady, no `litestreamDegradedReasons`, and
`litestreamCompactionLogFailureCount: 0` -- a nonzero count means litestream's own log reported
"compaction failed" or "validation error detected" recently (see
src/lib/runtime-health.ts's scanLitestreamRuntimeLogFile), which is direct evidence of a wedged
compaction level even when litestreamDegradedReasons stays empty (that field only ever reflects
level 0). `litestreamTierCoverage.remoteInventoryState` should read `ok` or `partial`, not
`missing`/`stale`/`failed` -- those mean the per-level breakdown (`litestreamTiers`) is currently
blind. Version pin:

```bash
grep LITESTREAM_VERSION scripts/coolify-prod-start.sh
```

Current pin: `0.5.12` (pinned back from `0.5.14` after the 2026-07-10 TCP socket-churn incident -- see Canon).

**`storageDegraded: true` / a `stale` or `stopped` reason = escalate immediately** on `#Work-In-Progress` with the `/api/health` output as evidence.

## 4. Known Failure Class: TCP Socket Churn (2026-07-10)

Litestream 0.5.14 leaked TCP sockets, exhausting kernel `tcp_mem`. Symptoms: deploys fail at `git clone` with TLS "unexpected eof"; app stays healthy but stale; `dmesg` shows "TCP: out of memory"; fd count on the litestream PID climbs into the thousands over the container's uptime (`ls /proc/<pid>/fd | wc -l`, sample more than once -- it's a sawtooth).

```bash
ssh ubuntu@141.148.182.224
cat /etc/sysctl.d/99-socratic-tcpmem.conf 2>/dev/null || echo "not raised"
```

The raised `tcp_mem` ceiling (`273945 365343 548010`, 3x the distro default) is **deliberately persisted** as headroom insurance while any leak-class risk remains -- do NOT revert it just because a deploy succeeded. Only remove the file (and run `sysctl --system`) once the 0.5.12 pin has run leak-free for days, per the rollout note's own follow-up.

## 5. Build Queue / Box-Local Checks

Builds serialize (`concurrent_builds=1`). If a deploy failed at build, or you need to bypass the CF-blocked API from section 2:

```bash
ssh ubuntu@141.148.182.224
df -h / | grep -E 'Use%|^/dev'
ps aux | grep nixpacks | grep -v grep   # a real build in progress; "deploy-runner" containers are idle GH Actions runners, not builds
docker ps --filter name=m1os7ijf31bg3fanil152e4b
```

Disk cleanup runs hourly above 60% use; sustained pressure past that, or a stuck build process, points to a wedged queue -- check Coolify's own logs (UI, or the box's `coolify` container logs) for OOM/disk-full.

## Canon (source of truth -- read these if anything conflicts)

- `docs/rollouts/2026-07-10-auto-deploy-on.md` -- auto-deploy mechanism & webhook verification
- `docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md` -- TCP socket churn diagnosis & sysctl relief
- `docs/rollouts/2026-07-07-prod-coolify-migration.md` -- Coolify production setup, FQDN scheme, SSL
- `docs/rollouts/2026-07-09-hetzner-8gb-server-migration.md` -- box specs, litestream R2 replica, API token location
- `docs/deployment.md` -- deploy flow summary and rollback boundary
- `AGENTS.md` "Hosting & dev servers" section -- app lifecycle, pm2 mac rollback, DB bootstrap modes

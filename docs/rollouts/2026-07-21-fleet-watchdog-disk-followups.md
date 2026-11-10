# 2026-07-21 — Fleet multi-app watchdog + disk follow-ups (GROK4)

## Summary

Completed the three host follow-ups after the disk-full / reboot-storm incident:

1. **Usage-Monitor Litestream retention 7d** — PR [#714](https://github.com/jaywedgeworth22/Usage-Monitor/pull/714) already **merged** (`retention: 168h`).
2. **Safer multi-app fleet watchdog** installed on the Hetzner Coolify host, **enabled on boot**.
3. **CI runner disk policy** re-applied: all github-runner services `EPHEMERAL=true` (restart stays `always` so the next job gets a fresh container).

## Does the watchdog run on the Mac?

**No.** It runs only on the **Hetzner production box** (`<HETZNER_OLD_IP_RETIRED>` / `host.jays.services`).

| Layer | Where | Boot behavior |
|-------|--------|----------------|
| `fleet-watchdog.service` | Hetzner | `WantedBy=multi-user.target` — starts when **the server** boots |
| Mac laptop | — | Not installed; closing/rebooting the Mac does nothing to the watchdog |

The previous unit `socratic-watchdog.service` remains **parked** as  
`/etc/systemd/system/socratic-watchdog.service.DISABLED-20260721` (do not re-enable — it rebooted the host after ~7 minutes of downtime and killed Coolify image builds).

## Fleet watchdog behavior

- **Script:** `/usr/local/bin/fleet-site-watchdog.sh`
- **Unit:** `/etc/systemd/system/fleet-watchdog.service` (`enabled` + `active`)
- **State:** `/var/lib/fleet-watchdog/`
- **Logs:** `journalctl -u fleet-watchdog -f`
- **Host README:** `/root/README-fleet-watchdog.txt`

| App | Check | Remediation |
|-----|--------|-------------|
| socratictrade.com | Public + local (Traefik Host header on `:443`) | Restart Coolify container `coolify.resourceName=socratic-trade-prod` after 180s confirmed local-down |
| congress.trade | Public only | Alert only (no app container on this host today) |
| usage.jays.services | Public only | Alert only |

Safety differences vs the parked watchdog:

- **`ALLOW_HOST_REBOOT=0`** (default) — will **not** reboot the host; that is what caused the 2026-07-21 deploy death spiral.
- **Never restarts the Docker daemon.**
- **Skips container restarts while Coolify/nixpacks build is active.**
- Liveness ≠ degraded 503 (2xx/3xx/4xx alive; 5xx with `checks.db == "ok"` still alive).
- Startup grace 300s; restart cooldown 600s; re-notify every 900s.

Optional: set `ALLOW_HOST_REBOOT=1` in the script only if you explicitly want host reboot after 3600s with 7200s cooldown — **not recommended** while deploys share this box.

## Runner policy (same host)

Compose: `/data/coolify/services/uhz1yhxevabvbf9eblxo4t8z/docker-compose.yml`

- All 7 runners: **`EPHEMERAL=true`**, **`restart: always`**
  - Ephemeral = one job then clean exit (limits workspace accumulation).
  - `restart: always` = Docker starts a **fresh** runner for the next job (using `restart: no` would leave CI dead after one job).
- Daily prune: `/etc/cron.d/hetzner-disk-guard` (`docker builder prune` + `image prune` at 04:15 UTC).
- Note: Coolify UI re-save of the github-runner service can rewrite compose and flip `EPHEMERAL` back to `false` — re-check after Coolify edits.

## Disk / site snapshot at install

| Check | Result |
|-------|--------|
| Disk | ~38% used (~45G free) after runner recreate |
| socratic health | 200, `ok: true`, sha `0eafc7d16c1c…` |
| fleet-watchdog | `active` + `enabled` |

## Litestream retention (Usage-Monitor)

PR #714 merged: snapshot retention **720h → 168h (7d)** so Garage on the shared 75G disk stops unbounded growth. Ops already deleted legacy buckets and pruned old LTX. Oracle will pick up the new `litestream.yml` on next deploy/restart of Usage-Monitor production.

## Files (ops host — not in this git commit unless mirrored)

- `/usr/local/bin/fleet-site-watchdog.sh` (new)
- `/etc/systemd/system/fleet-watchdog.service` (new, enabled)
- `/root/README-fleet-watchdog.txt`
- github-runner compose: `EPHEMERAL: 'true'` on all services

## Verification

```bash
ssh -i ~/.ssh/hetzner root@<HETZNER_OLD_IP_RETIRED> 'systemctl is-enabled fleet-watchdog; systemctl is-active fleet-watchdog; journalctl -u fleet-watchdog -n 20 --no-pager'
curl -sS https://socratictrade.com/api/health | head -c 200
df -h /
```

## Follow-ups

- If Coolify re-saves the runner service and resets `EPHEMERAL`, re-apply true.
- Optional: persist a copy of `fleet-site-watchdog.sh` in-repo under `scripts/ops/` for recoverability.
- Usage-Monitor Oracle restart if 7d retention not yet live in the running litestream process.
- Re-proxy `host.jays.services` through Cloudflare only after origin stays healthy (owner DNS choice).

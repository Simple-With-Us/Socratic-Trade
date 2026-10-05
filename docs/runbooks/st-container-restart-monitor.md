# Runbook — ST Docker container restart monitor (host)

## Why

Coolify replaces the ST container on crash or deploy.  When the container **never reaches Node**
(boot failure, OOM, healthcheck kill loop), the in-app boot ledger (`src/lib/boot-ledger.ts`)
cannot run.  This host-side monitor samples Docker `RestartCount` and container state on
**fleet-hetzner-nbg1** and pages when restarts cluster or the container vanishes.

Board: `2ad7f8b92e864958887e72fc25572c34` (GB-HOUSEKEEPER).  Complements board `a9676caf`
(boot-ledger, in-container).

## What it does

| Signal | Threshold (default) | Meaning |
| --- | --- | --- |
| Restart delta | 3 increases within 15 minutes | Crash / restart loop on the same container id |
| Status `restarting` | 2 consecutive samples | Docker has not stabilized |
| Container missing | Was running, now no match for Coolify id | Deploy stuck or container removed while unhealthy |

Coolify application UUID (name filter): `d83b1aykr03uwr32yhgzaiay` (`ST_RESTART_MONITOR_COOLIFY_ID`).

State file: `/var/lib/st-container-restart-monitor/state.json` (restart timestamps + dedupe).

## Alert channels (existing env names only)

Configure on the host in `/etc/default/st-container-restart-monitor`:

| Channel | Variables | Notes |
| --- | --- | --- |
| Pushover | `PUSHOVER_ST_API_TOKEN` or `PUSHOVER_APP_TOKEN`, plus `PUSHOVER_USER_KEY` | Same names as `INFISICAL.md` / `src/lib/notify.ts` |
| Sentry fleet-infra (PagerDuty route) | `SENTRY_FLEET_DSN` | Same secret as `.github/workflows/sentry-ci-report.yml` |

Set `ST_RESTART_MONITOR_NOTIFY=1` to send alerts.  Default cooldown between pages: 3600s
(`ST_RESTART_MONITOR_ALERT_COOLDOWN_SECONDS`).

## Install (owner on host — agents do not deploy)

From a checkout of this repo on **fleet-hetzner-nbg1**, as root:

```bash
cd /path/to/Socratic-Trade
bash scripts/ops/install-st-container-restart-monitor.sh
```

Then edit `/etc/default/st-container-restart-monitor` (created from
`scripts/ops/st-container-restart-monitor.env.example`) with real tokens.  Restrict permissions:
`chmod 640 /etc/default/st-container-restart-monitor`.

Dry-run without paging:

```bash
ST_RESTART_MONITOR_NOTIFY=0 /usr/local/sbin/st-container-restart-monitor.sh
```

Timer: `st-container-restart-monitor.timer` (about every 15 minutes).  Logs:
`journalctl -u st-container-restart-monitor.service`.

## Verify after install

```bash
systemctl list-timers st-container-restart-monitor.timer
ST_RESTART_MONITOR_NOTIFY=0 systemctl start st-container-restart-monitor.service
journalctl -u st-container-restart-monitor.service -n 20 --no-pager
cat /var/lib/st-container-restart-monitor/state.json | jq .
```

Manual inspect (production):

```bash
CID=$(docker ps -q -f name=d83b1aykr03uwr32yhgzaiay | head -1)
docker inspect -f 'name={{.Name}} restartCount={{.RestartCount}} status={{.State.Status}}' "$CID"
```

## Related

- `docs/rollouts/2026-09-18-restart-loop-boot-ledger.md` — in-app ledger (host half was follow-up)
- `docs/runbooks/uptime-health-json-monitors.md` — HTTP/JSON monitors (do not replace this)
- `scripts/alert-deploy-freshness.sh` — silent deploy freeze (different failure class)

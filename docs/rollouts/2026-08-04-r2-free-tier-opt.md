# 2026-08-04 — R2 free-tier optimization (ST + fleet) [GROK]

## Problem

| Account | Storage | Class A pace (0.2 floor) |
|---------|---------|--------------------------|
| ST | 5.66 GiB (57%) | **74%** → kill-switch re-fired |
| CT | 5.96 GiB (60%) | **123%** projected |
| UM | **10.45 GiB (104%)** | 26% (storage is the issue) |

App request latency is unaffected by litestream; only **backup RPO** changes.

## Changes (ops + code)

| App | sync-interval | snapshot retention |
|-----|---------------|--------------------|
| ST | 10s/30s → **60s** | 48h → **24h** |
| CT (host) | 30s → **60s** | 72h → **36h** |
| UM | (default 1s) → **60s** | 168h → **48h** |

- ST kill-switch marker cleared; litestream resumed under new config.
- CT `litestream-congress` restarted; logs show `sync-interval=1m0s`.

## Why this is safe

- RPO 60s is still fine for free-tier PITR (was already 10–30s for socket-leak reasons).
- Retention still covers same-day + next-day deploy rollback.
- No change to app write path, caches, or request handlers.

## Verification

```bash
# ST
docker top socratic-app | grep litestream
docker exec socratic-app grep -E 'retention|sync-interval' /app/litestream.coolify.yml
# CT
systemctl is-active litestream-congress
journalctl -u litestream-congress -n 5 | grep sync-interval
```

Watch free-tier GraphQL (storage latest + Class A MTD pace) over 24–48h.

## Follow-ups

- UM: after deploy, confirm usage-monitor-bucket drops below ~5 GiB as GC runs.
- Optional R2 lifecycle rule (delete LTX older than 2d) if GC lags.

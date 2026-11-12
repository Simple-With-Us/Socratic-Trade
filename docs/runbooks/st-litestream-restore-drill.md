# Runbook — ST Litestream B2 restore drill (host, scheduled)

## Why

Tier-1 backups are not proven until a full B2 restore succeeds on the production host.
`scripts/litestream-restore-drill.sh` is the manual drill; this timer automates it weekly
off-hours without touching live `app.db` or the replica.

Policy: `docs/backup-policy.md`.  Linear: ST-4622.

## What it does

| Step | Behavior |
| --- | --- |
| Preflight | Requires B2 creds in `/etc/default/st-litestream-restore-drill` (mode 0600) |
| Disk | Refuses unless scratch parent has >= 2.2x live DB free space (default parent `/data/scratch`) |
| Drill | Runs `litestream-restore-drill.sh` under `timeout` (default 6h) in an ephemeral scratch dir |
| Status | Writes `/var/lib/st-ops/litestream-restore-drill-status.json` |
| Alert | One Sentry event on failure when `ST_RESTORE_DRILL_NOTIFY=1` and `SENTRY_FLEET_DSN` is set |

Timer: `st-litestream-restore-drill.timer` — Sunday 04:00 UTC with `RandomizedDelaySec=3600`.

## Install (owner on host — agents do not deploy)

From a checkout on **fleet-hetzner-nbg1**, as root:

```bash
cd /path/to/Socratic-Trade
bash scripts/ops/install-st-litestream-restore-drill.sh
```

Populate `/etc/default/st-litestream-restore-drill` from an Infisical **service token**
(operator).  Never commit secrets.  Keep mode `0600`.

Dry-run once without Sentry:

```bash
ST_RESTORE_DRILL_NOTIFY=0 /usr/local/sbin/st-litestream-restore-drill.sh
```

## Verify after install

```bash
systemctl list-timers st-litestream-restore-drill.timer
ST_RESTORE_DRILL_NOTIFY=0 systemctl start st-litestream-restore-drill.service
journalctl -u st-litestream-restore-drill.service -n 50 --no-pager
jq . /var/lib/st-ops/litestream-restore-drill-status.json
```

Hermetic selftest (any Linux dev seat):

```bash
bash scripts/ops/st-litestream-restore-drill.selftest.sh
```

## Uninstall

```bash
bash scripts/ops/install-st-litestream-restore-drill.sh --uninstall
```

## Related

- `scripts/litestream-restore-drill.sh` — manual drill (same assertions)
- `scripts/ops/verify-cold-snapshot-restore.mjs` — tier-3 cold archive drill
- `docs/litestream.md` — replication config and history

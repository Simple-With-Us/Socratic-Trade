# 2026-11-12 — ST-4622 scheduled Litestream B2 restore drill

## Context & Objective

Tier-1 continuous replication had only one recorded manual restore proof while `app.db` grew
toward ~19 GB.  ST-4622 adds a host systemd timer plus wrapper so the B2 restore drill runs
weekly off-hours with disk preflight, bounded timeout, JSON status, and Sentry on failure.

## Changes Made

- Weekly `st-litestream-restore-drill` systemd oneshot + timer (Sunday 04:00 UTC, idle I/O).
- Host wrapper: 2.2x disk preflight, ephemeral scratch dir, 6h timeout, status JSON under
  `/var/lib/st-ops/`, Sentry via shared fleet helper.
- `litestream-restore-drill.sh`: optional `RESTORE_DRILL_STATUS_JSON` and `RESTORE_DRILL_MIN_FREE_TENTHS`
  (manual default unchanged at 1.0x).
- Idempotent installer with `--dry-run` / `--uninstall`; runbook + backup-policy cadence update.

**Files touched:**

- `scripts/ops/st-litestream-restore-drill.sh`
- `scripts/ops/st-litestream-restore-drill.service`
- `scripts/ops/st-litestream-restore-drill.timer`
- `scripts/ops/st-litestream-restore-drill.env.example`
- `scripts/ops/install-st-litestream-restore-drill.sh`
- `scripts/ops/st-litestream-restore-drill.selftest.sh`
- `scripts/ops/st-litestream-restore-drill-sentry.py`
- `scripts/litestream-restore-drill.sh`
- `docs/backup-policy.md`
- `docs/runbooks/st-litestream-restore-drill.md`
- `docs/rollouts/2026-11-12-st-4622-litestream-restore-drill-timer.md`
- `.github/workflows/ci.yml`
- `STATUS.md`

## Decisions & Trade-offs

- Reused `st-container-restart-monitor-sentry.py` rather than a second DSN client.
- Installer places drill script in `/usr/local/sbin/` next to the wrapper (same pattern as restart monitor).
- Did not wire Pushover for drill failure (Sentry only; matches brief).

## Verification State

```bash
bash -n scripts/ops/st-litestream-restore-drill.sh
bash -n scripts/ops/install-st-litestream-restore-drill.sh
bash -n scripts/ops/st-litestream-restore-drill.selftest.sh
bash -n scripts/litestream-restore-drill.sh
bash scripts/ops/st-litestream-restore-drill.selftest.sh
python3 -m py_compile scripts/ops/st-litestream-restore-drill-sentry.py
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

1. **Owner:** install on the production restore-drill host, fill `/etc/default/st-litestream-restore-drill` from Infisical service token, run one notify-disabled manual start via the env-file pattern in the runbook.
2. After first green scheduled run, add rollout receipt to THE BOARD.

## Zero-Code Findings

None.

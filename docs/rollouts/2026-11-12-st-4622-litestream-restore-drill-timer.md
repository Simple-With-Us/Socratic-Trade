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
- `scripts/ops/st-litestream-restore-drill-start-notify-off.sh`
- `scripts/ops/install-st-litestream-restore-drill.sh`
- `scripts/ops/st-litestream-restore-drill.selftest.sh`
- `scripts/ops/st-litestream-restore-drill-sentry.py`
- `scripts/litestream-restore-drill.sh`
- `docs/backup-policy.md`
- `docs/runbooks/st-litestream-restore-drill.md`
- `docs/rollouts/2026-11-12-st-4622-litestream-restore-drill-timer.md`
- `.github/workflows/ci.yml`

The ST-4622 `STATUS.md` entry ships in the status follow-up PR
[#5391](https://github.com/Simple-With-Us/Socratic-Trade/pull/5391), not here, so
this PR does not edit `STATUS.md`.

## Decisions & Trade-offs

- Reused `st-container-restart-monitor-sentry.py` rather than a second DSN client.
- Installer places drill script in `/usr/local/sbin/` next to the wrapper (same pattern as restart monitor).
- Did not wire Pushover for drill failure (Sentry only; matches brief).
- Scheduled B2 credentials come from Infisical via a service token file
  (`INFISICAL_TOKEN_FILE`), not from plaintext keys in the env file, and not
  via machine identities or universal auth.  Project id, path, and secret names
  are config that must be confirmed on the host.
- A notify-disabled `systemctl start` uses a non-persistent `/run` drop-in that the
  helper removes when it exits, including on HUP, INT or TERM.  If the helper is
  killed with SIGKILL (or the host crashes) before its trap runs, the override
  survives until the next reboot and later scheduled failures send no Sentry
  alert, so run the helper with `--cleanup` (or rerun it, or reboot the host)
  before the next scheduled run to restore weekly failure alerts.

## Verification State

```bash
bash -n scripts/ops/st-litestream-restore-drill.sh
bash -n scripts/ops/install-st-litestream-restore-drill.sh
bash -n scripts/ops/st-litestream-restore-drill.selftest.sh
bash -n scripts/ops/st-litestream-restore-drill-start-notify-off.sh
bash -n scripts/litestream-restore-drill.sh
bash scripts/ops/st-litestream-restore-drill.selftest.sh
bash scripts/litestream-restore-drill.selftest.sh
python3 -m py_compile scripts/ops/st-litestream-restore-drill-sentry.py
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

1. **Owner:** install on the production restore-drill host.  Fill
   `/etc/default/st-litestream-restore-drill` with non-secret config, put an
   Infisical **service token** in the file named by `INFISICAL_TOKEN_FILE`
   (mode 0600), set `INFISICAL_PROJECT_ID`, and confirm domain/env/path and
   secret names (defaults `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   optional `SENTRY_FLEET_DSN`).  Run one notify-disabled start with
   `st-litestream-restore-drill-start-notify-off.sh` (runtime drop-in; do not
   patch the env file).
2. After first green scheduled run, add rollout receipt to THE BOARD.

## Zero-Code Findings

None.

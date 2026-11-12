# ST-4623 host systemd timer dead-man (Sentry Crons)

## Context & Objective

`<host>` below is the dedicated fleet host that runs the ST systemd timers; the installers check it at install time.

ST host systemd timers on `<host>` (`litestream-l1-boundary-trim`, `st-container-restart-monitor`) had no dead-man alerting when a timer stopped firing or the oneshot kept failing.  This adds reusable Sentry Crons check-ins (in_progress then ok/error) around each ST oneshot, mirroring `scripts/sentry-ci-report.py`.

## Changes Made

- `scripts/ops/sentry-cron-checkin.py` — stdlib wrap helper; DSN from env file; fail-open HTTP.  A missing or malformed DSN exits 78 (EX_CONFIG) naming `SENTRY_CRONS_DSN` / `SENTRY_FLEET_DSN` before the job starts; `SENTRY_CRONS_DISABLED=1` is the only bypass and logs a warning each run.  `--env-file` works before or after `wrap`.  The child runs under `Popen` with SIGTERM/SIGINT forwarded, so a systemd stop still sends the terminal `error` check-in.  A command that cannot be spawned sends `error` and exits 127.  A child killed by signal N exits 128+N.  A `check` mode backs the installer preflight.
- `scripts/ops/st-host-cron-sentry.env.example` — shared `/etc/default/st-host-cron-sentry` template.
- `scripts/ops/litestream-l1-boundary-trim.service` — Crons wrap with slug `st-host-litestream-l1-boundary-trim`, schedule `4 0 * * *`.
- `scripts/ops/st-container-restart-monitor.service` — Crons wrap with slug `st-host-st-container-restart-monitor`, schedule `2,17,32,47 * * * *`.  Exit 2 (incident found) reports Crons `error`.
- `scripts/ops/st-container-restart-monitor.timer` — `OnCalendar=*:02,17,32,47 UTC`, so the timer fires on the same UTC clock the Crons schedule declares (matches `litestream-l1-boundary-trim.timer`).
- `scripts/ops/install-litestream-l1-trim.sh`, `scripts/ops/install-st-container-restart-monitor.sh` — install check-in script + env file (idempotent).  Preflight `sentry-cron-checkin.py check` runs before any unit changes and exits 1 when no DSN is set and Crons are not disabled.
- `scripts/ops/st-container-restart-monitor.env.example` — pointer to shared Crons env.
- `test/sentry-cron-checkin.test.ts` — runs `scripts/ops/sentry-cron-checkin.selftest.sh`: stub HTTP server tests (ok, error, Sentry down, disabled) plus `scripts/ops/sentry_cron_checkin_test.py` unittests (missing DSN, `--env-file` after `wrap`, spawn failure, SIGTERM, signal exit, exit 2, timer UTC pin).

## Decisions & Trade-offs

- **Restore-drill unit (ST-4622):** not present on `main` at implementation time.  When that unit lands, add `EnvironmentFile=-/etc/default/st-host-cron-sentry` and wrap `ExecStart` the same way with a slug `st-host-<unit-name>` and the timer's crontab.
- **Exit 2 on restart monitor:** reported as Crons `error`.  The earlier `--treat-exit-2-as-ok` flag is removed: the monitor exits 2 whenever it finds an incident, even when Pushover/Sentry delivery failed, so `ok` could hide a real outage.  The cost is a Crons error alongside the script's own alert while an incident lasts.
- **Missing DSN fails before the job runs:** a lost secret must not look like an opt-out.  The unit fails (exit 78) and shows in `systemctl --failed`; the installers refuse to change units until a DSN or `SENTRY_CRONS_DISABLED=1` is set, so a fresh install cannot silently stop the restart monitor or the trim.
- **`SENTRY_CRONS_DISABLED=1` does not pause Sentry:** pause or delete the `st-host-litestream-l1-boundary-trim` and `st-host-st-container-restart-monitor` monitors in Sentry Crons before setting it, or Sentry pages on every missed check-in.
- **Stops:** SIGTERM/SIGINT are forwarded to the child (systemd's default `KillMode=control-group` also signals it directly, which is harmless) and the run reports `error`.  SIGKILL and hard reboots still rely on `max_runtime`.
- **Margins:** L1 trim uses 120 min margin / 180 min max_runtime (three-app sequential nightly); restart monitor uses 20 / 15 min aligned to ~15m timer.

## Verification State

```bash
python3 -m py_compile scripts/ops/sentry-cron-checkin.py
npx vitest run test/sentry-cron-checkin.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- Jay: set `SENTRY_CRONS_DSN` in `/etc/default/st-host-cron-sentry` (mode 0600) from Infisical, then re-run both installers on `<host>` (they refuse without it); confirm monitors appear in Sentry Crons.

## Zero-Code Findings

None.

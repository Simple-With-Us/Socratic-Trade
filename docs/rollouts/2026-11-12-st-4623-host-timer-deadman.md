# ST-4623 host systemd timer dead-man (Sentry Crons)

## Context & Objective

ST host systemd timers on fleet-hetzner-nbg1 (`litestream-l1-boundary-trim`, `st-container-restart-monitor`) had no dead-man alerting when a timer stopped firing or the oneshot kept failing.  This adds reusable Sentry Crons check-ins (in_progress then ok/error) around each ST oneshot, mirroring `scripts/sentry-ci-report.py`.

## Changes Made

- `scripts/ops/sentry-cron-checkin.py` — stdlib wrap helper; DSN from env file; `SENTRY_CRONS_DISABLED` opt-out; fail-open HTTP.
- `scripts/ops/st-host-cron-sentry.env.example` — shared `/etc/default/st-host-cron-sentry` template.
- `scripts/ops/litestream-l1-boundary-trim.service` — Crons wrap with slug `st-host-litestream-l1-boundary-trim`, schedule `4 0 * * *`.
- `scripts/ops/st-container-restart-monitor.service` — Crons wrap with slug `st-host-st-container-restart-monitor`, schedule `2,17,32,47 * * * *`, `--treat-exit-2-as-ok`.
- `scripts/ops/install-litestream-l1-trim.sh`, `scripts/ops/install-st-container-restart-monitor.sh` — install check-in script + env file (idempotent).
- `scripts/ops/st-container-restart-monitor.env.example` — pointer to shared Crons env.
- `test/sentry-cron-checkin.test.ts` — stub HTTP server tests (ok, error, Sentry down, disabled).

## Decisions & Trade-offs

- **Restore-drill unit (ST-4622):** not present on `main` at implementation time.  When that unit lands, add `EnvironmentFile=-/etc/default/st-host-cron-sentry` and wrap `ExecStart` the same way with a slug `st-host-<unit-name>` and the timer's crontab.
- **Exit 2 on restart monitor:** treated as Crons `ok` (alert fired but job ran); exit 1 and other non-zero map to `error`.
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

- Jay: re-run both installers on fleet-hetzner-nbg1; set `SENTRY_CRONS_DSN` in `/etc/default/st-host-cron-sentry` (mode 0600) from Infisical; confirm monitors appear in Sentry Crons.

## Zero-Code Findings

None.

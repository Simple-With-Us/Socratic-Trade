# 2026-10-05 - st-container-restart-monitor (host)

## Context & Objective

Board `2ad7f8b92e864958887e72fc25572c34` (GB-HOUSEKEEPER): production needs a **host-side**
Docker restart-count monitor for the Coolify ST container.  The in-app boot ledger cannot run if
the container never reaches Node.  This change adds the script, systemd timer, install helper, and
runbook only — **no host deploy from this agent**.

## Changes Made

- Host monitor samples `RestartCount`, Docker state, and container presence for Coolify id
  `<st-container-id>` (resolved at install time).
- Alerts use the ST Pushover token and Sentry DSN from Infisical.
- Systemd oneshot + timer; install script copies to `/usr/local/sbin` and enables the timer.

### Files

- `scripts/ops/st-container-restart-monitor.sh`
- `scripts/ops/st-container-restart-monitor-sentry.py`
- `scripts/ops/st-container-restart-monitor.service`
- `scripts/ops/st-container-restart-monitor.timer`
- `scripts/ops/st-container-restart-monitor.env.example`
- `scripts/ops/install-st-container-restart-monitor.sh`
- `scripts/ops/st-container-restart-monitor.selftest.sh`
- `docs/runbooks/st-container-restart-monitor.md`
- `docs/rollouts/2026-10-05-st-container-restart-monitor.md`
- `STATUS.md`, `docs/EFFORT-LOG.md`, `PLAN.md`

## Decisions & Trade-offs

- **Counts restart deltas on a stable container id**; id change resets the window (normal deploy).
- **Does not call Coolify API or restart containers** — read-only `docker inspect`, same class as
  `scripts/alert-deploy-freshness.sh`.
- **Reuses the existing notify secrets** — no new Infisical keys invented in code.  Public prose
  names the host by role ("the fleet Hetzner host"), the Coolify id as `<st-container-id>`
  resolved at install time, and the pages as the ST Pushover token and Sentry DSN from Infisical.
  Runtime code still reads its env var names.
- **15-minute sample interval** balances detection vs. noise; tunable via timer unit if owner wants
  faster sampling.
- **Terminal states** `exited` and `dead` page when no live container matches the Coolify name.
  A container-id change clears the previous status so a deploy does not inherit `restarting`.
- **Cooldown** is stored only after Pushover or Sentry actually accepts the page. The form body
  is posted on stdin so the Pushover token is not in `curl` argv.

## Verification State

```bash
bash -n scripts/ops/st-container-restart-monitor.sh
bash -n scripts/ops/install-st-container-restart-monitor.sh
bash -n scripts/ops/st-container-restart-monitor.selftest.sh
bash scripts/ops/st-container-restart-monitor.selftest.sh
python3 -m py_compile scripts/ops/st-container-restart-monitor-sentry.py
```

Ran on Linux after the review fixes (2026-10-07): `bash -n` on the three shell scripts exited 0,
`python3 -m py_compile` exited 0, and a direct `parse_dsn` check mapped
`https://abc@sentry.example.com/prefix/123` to `https://sentry.example.com/api/prefix/123/envelope/`
and `http://abc@127.0.0.1:9000/1` to `http://127.0.0.1:9000/api/1/envelope/`.
`bash scripts/ops/st-container-restart-monitor.selftest.sh` printed `selftest: 9 passed, 0 failed.`

2026-10-09 public-copy pass (Linux): `git merge origin/main` already up to date.  `shellcheck`
on `st-container-restart-monitor.sh` and `install-st-container-restart-monitor.sh` exited 0.
`bash -n` on those two plus the selftest exited 0.  `bash scripts/ops/st-container-restart-monitor.selftest.sh`
printed `selftest: 9 passed, 0 failed.`  `python3 -m py_compile` on the sentry helper exited 0.
`shellcheck` on the selftest still warns SC1007 and SC2294 (pre-existing harness); tests pass.

Host-script change: full `npm run lint` / `npm test` / `npm run build` not required for merge-gate
relevance; no app runtime code touched.

## Next Steps & Blockers

1. **Owner:** run `install-st-container-restart-monitor.sh` on the fleet Hetzner host, fill
   `/etc/default/st-container-restart-monitor`, confirm one dry-run and one timer tick in
   `journalctl`.
2. Optional: add a Sentry Crons monitor for the timer once it has run in production.

## Zero-Code Findings

- Existing host tooling: `/usr/local/sbin/fleet-health-verify.sh` (edge HTTP only), retired
  `fleet-site-watchdog.service` (deleted script).  Litestream L1 trim timer is the current pattern
  for fleet host systemd units sourced from this repo.

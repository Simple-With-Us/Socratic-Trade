# 2026-07-04 — Fleet-wide Sentry observability (host monitor + additive CI failure reporter)

## Summary

Built fleet-wide operational observability into the existing Sentry project `fleet-infra`
(org `jays-services`), in two independent parts:

- **Part A (machine-side, no repo dependency):** a Python host monitor
  (`/Users/jay/apps/fleet-sentry-monitor/monitor.py`) registered under pm2, watching pm2 app
  health, disk/WAL space, Claude desktop presence, GitHub API rate budget, and self-hosted Actions
  runner status, plus its own Sentry Crons self-check-in so a dead monitor alerts by absence.
- **Part B (repo-side, additive only):** a new GitHub Actions workflow
  (`.github/workflows/sentry-ci-report.yml`) plus a new script
  (`scripts/sentry-ci-report.py`) that listens for every other workflow's completion and reports
  failures as Sentry events, and reports scheduled-workflow outcomes as Sentry Crons check-ins so a
  silently-stopped nightly/weekly job also alerts by absence. Zero edits to any pre-existing
  workflow file.

This addresses a confirmed real gap: `trading-codex` recently crash-looped to ~1,621 pm2 restarts
silently (no alert fired anywhere), and the fleet has separately hit low GitHub API rate-limit
availability twice in one day. Both classes of failure are now covered.

## Why

- Nothing in the fleet previously watched pm2 process health, disk/WAL growth, or `gh` rate budget
  across the many concurrent agent worktrees/previews on this machine — failures like the
  `trading-codex` crash loop were only found by manually inspecting `pm2 jlist`, well after the
  fact.
- CI workflow failures (and, more insidiously, a scheduled workflow that stops running entirely —
  which produces *no* red X, just silence) had no push notification path outside of GitHub's own
  UI/email.
- The repo already has a per-request `SENTRY_DSN` for application telemetry
  (`sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts`) and an existing
  Sentry Crons pattern for the in-app scheduler tick (`src/lib/scheduler.ts`,
  `sendSentrySchedulerCheckIn`/`SENTRY_CRON_MONITOR_SLUG = "scheduler-tick"`). This work is a
  **separate, fleet-level** concern (machine/CI health, not application telemetry) and deliberately
  uses a different Sentry project (`fleet-infra`) and DSN (`SENTRY_FLEET_DSN`) so the two concerns
  don't share fingerprint/alerting noise. The `captureCheckIn`/upsert-monitor-config pattern in
  `scheduler.ts` was used as the reference shape for both the Python monitor's check-in and the
  workflow's raw-envelope check-in.

## Design notes / decisions

- **Part A cadence:** rather than an in-process `while True: sleep(120)` loop (which risks a single
  wedged pass never recovering), the script does exactly one pass then sleeps 120s and exits 0; pm2
  restarts it immediately, giving the same effective cadence with pm2's own restart/backoff
  semantics as the safety net. `pm2 jlist`, disk, and `gh` calls are all individually try/caught so
  one flaky check never aborts the whole pass or crashes the process.
- **Crash-loop detection is delta-based, not absolute.** `trading-codex` already sits at
  `restart_time: 1621` (a real, currently-elevated baseline) — flagging on an absolute threshold
  would false-positive forever. The monitor persists each app's restart count in `state.json` and
  only fires when the count climbs by >= 5 **within one ~120s interval**, matching the spec
  ("restart delta >= 5 per interval") and confirmed not to fire spuriously against the real
  pre-existing count.
- **Dedup via fingerprint + timestamp in the same state file**, re-emitting a persisting condition
  at most once per hour, so a stuck condition doesn't page every 120s forever.
- **Secrets discipline:** `monitor.py` reads `SENTRY_FLEET_DSN` from its own `.env` (or the
  environment) via a dedicated `load_dsn()` that is never logged, printed, or included in any
  exception text; the DSN is parsed into its components (public key / host / project id) purely to
  build the raw-envelope fallback URL, again without ever surfacing the original string. The GitHub
  Actions side reads the same value only via `secrets.SENTRY_FLEET_DSN` (repo secret, set via
  `gh secret set ... < .env`, piped so the value never appears in shell history/logs/this
  transcript) and only ever prints `::warning::`-level diagnostics, never the DSN.
- **`sentry-sdk` deprecation:** initial draft used `sentry_sdk.push_scope()` (event-tagging
  context manager), which the installed 2.64.0 SDK flags as deprecated in favor of
  `sentry_sdk.new_scope()`. Fixed before registering under pm2.
- **Part B implementation shape:** the first draft embedded Python via inline heredocs
  (`python3 - ... <<'PYEOF'`) directly inside the workflow's `run: |` block scalar. That broke YAML
  parsing (`yaml.scanner.ScannerError: could not find expected ':'`) because heredoc body lines at
  column 0 are less indented than the block scalar and terminate it early. Rewrote as a standalone
  `scripts/sentry-ci-report.py` invoked with `python3 scripts/sentry-ci-report.py` — simpler,
  testable in isolation, and avoids YAML/shell/Python triple-quoting fragility entirely. The
  workflow does a `sparse-checkout` limited to that one script path (still additive — it doesn't
  read or touch any other file in the repo).
- **Runner status is context-only per spec**, even though the runner (`trading-live-mac`) was
  observed `online` during this work — the check treats "offline" as expected/normal and never
  raises a warning/error either way; it exists purely as a Sentry breadcrumb for context when
  investigating other issues.
- **Cron expressions are hand-mirrored, not auto-derived**, from each source workflow's own
  `schedule:` block (`security.yml` `41 10 * * 1`, `e2e.yml` `17 9 * * 1`,
  `shared-package-pin-check.yml` `0 13 * * 1`) into a `CRON_SCHEDULES` dict in
  `scripts/sentry-ci-report.py`. This is a known manual-sync point flagged in both the script's
  docstring and this note: if those workflows' `schedule:` blocks change, `CRON_SCHEDULES` must be
  updated to match or the Sentry Crons monitor's expected-schedule will silently drift from reality
  (it would then flag a healthy run as "early/late" or, if the corresponding workflow's schedule is
  removed, an orphaned monitor with no incoming check-ins).

## Files

**Part A (machine-side, not in this repo):**
- `/Users/jay/apps/fleet-sentry-monitor/monitor.py` — new host monitor script.
- `/Users/jay/apps/fleet-sentry-monitor/venv/` — new Python venv with `sentry-sdk` (+ `pyyaml`,
  used only for this session's own workflow-YAML validation, not a runtime dependency of
  `monitor.py`).
- `/Users/jay/apps/fleet-sentry-monitor/state.json` — new, git-ignored-by-location state file
  (restart-count baselines + dedup fingerprints).
- `/Users/jay/apps/fleet-sentry-monitor/.env` — pre-existing, untouched; `SENTRY_FLEET_DSN` was
  already present.
- pm2: new app `fleet-sentry-monitor` added via `pm2 start`, persisted via `pm2 save`. No existing
  pm2 app was touched, renamed, or deleted.

**Part B (this repo, worktree `~/apps/trading-wt-sentry-ci`, branch
`claude/sentry-ci-observability`):**
- `.github/workflows/sentry-ci-report.yml` — new, additive only.
- `scripts/sentry-ci-report.py` — new, additive only.
- `STATUS.md` — prepended this entry.
- `docs/EFFORT-LOG.md` — added under "In Progress" (Wave-1 RAG quick-wins section), to be moved to
  Completed on merge.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — updated the existing "Fleet observability via Sentry"
  In Progress row with full implementation detail (this is the branch-neutral live board, outside
  this repo).
- `docs/rollouts/2026-07-04-fleet-sentry-observability.md` — this note.
- GitHub repo secret `SENTRY_FLEET_DSN` — set via `gh secret set SENTRY_FLEET_DSN --repo
  jaywedgeworth22/agentic-trading` (value piped directly from the `.env` file, never displayed).

No existing workflow file (`ci.yml`, `codex-autofix.yml`, `deploy.yml`, `e2e.yml`, `security.yml`,
`shared-package-pin-check.yml`, `sync-previews.yml`) was modified. No existing pm2 app was
modified.

## Verification

**Part A:**
- `python3 -m py_compile monitor.py` — clean.
- Manual single-pass runs (`venv/bin/python -c "import monitor; monitor.CHECK_INTERVAL_SECONDS = 0;
  monitor.main()"`) — first pass established the `state.json` restart-count baseline and correctly
  fired a disk-free warning (real free space was 15.9GB, under the 20GB threshold); second pass
  correctly suppressed the same warning under the hourly dedup window; a synthetic mutation of
  `trading-codex`'s prior baseline (-7) correctly fired `pm2 crash loop: trading-codex` with
  `restart_delta: 7`; a final pass restored the real baseline.
- Registered under pm2 (`pm2 start venv/bin/python --name fleet-sentry-monitor --cwd
  /Users/jay/apps/fleet-sentry-monitor --interpreter none -- monitor.py`, then `pm2 save`).
  Confirmed via `pm2 jlist`: `status: online`. Watched two real pm2-driven pass cycles complete
  end-to-end (`pass complete at ... sleeping 120s` in the pm2 logs), each ending in
  `Sentry Crons check-in sent: ok`. One of those live passes independently caught a real
  `gh core rate limit low: 60 remaining` / `gh graphql rate limit low: 0 remaining` condition
  (this session's own testing plus other concurrent agents burned the shared rate limit), which is
  exactly the class of failure this check exists to catch.
- Confirmed `SENTRY_FLEET_DSN` is never printed/logged anywhere in script output, `pm2 logs`, or
  this transcript — only referenced by name.

**Part B:**
- `python3 -m py_compile scripts/sentry-ci-report.py` — clean.
- YAML validated via `yaml.safe_load()` (PyYAML) against `.github/workflows/sentry-ci-report.yml`
  — confirmed `workflow_run.workflows` lists all 7 existing workflow names and
  `types: [completed]`.
- Local dry run of `scripts/sentry-ci-report.py` against the real `SENTRY_FLEET_DSN`, simulating a
  `Security` workflow failure on a schedule trigger: both the failure-event envelope POST and the
  Crons check-in envelope POST returned `HTTP 200`.
- `git status --short` in the worktree after all edits: only new/untracked files
  (`.github/workflows/sentry-ci-report.yml`, `scripts/sentry-ci-report.py`, plus doc files) — no
  existing tracked file shows as modified, confirming the additive-only boundary.
- `gh secret list --repo jaywedgeworth22/agentic-trading` confirms `SENTRY_FLEET_DSN` is set (name
  + timestamp only).
- Full verify quartet (lint / tsc / test / build) run before landing — see the PR for the exact
  `land.sh` output; this note is written before that final run completes, so check the PR's CI
  status and the `land.sh` console output for the authoritative pass/fail record.

## PLAN.md

Not touched. This is fleet/CI operational tooling, not a change to the trading product's roadmap,
scope, or timeline — same precedent as the recent `claude/ci-actions-efficiency` Actions-minutes
lane, which also didn't touch `PLAN.md`.

## Follow-ups

- If `security.yml`, `e2e.yml`, or `shared-package-pin-check.yml`'s `schedule:` cron expressions
  ever change, update the matching entry in `scripts/sentry-ci-report.py`'s `CRON_SCHEDULES` dict
  (and the mirrored comment block at the top of `sentry-ci-report.yml`) in the same change, or the
  Sentry Crons monitor's expected schedule silently drifts from the real one.
- If a new workflow is added to `.github/workflows/`, it will not be observed by
  `sentry-ci-report.yml` until its name is added to that workflow's `on.workflow_run.workflows`
  list (and, if it has its own `schedule:`, to `CRON_SCHEDULES` too).
- The host monitor's dedup window (1 hour) and crash-loop threshold (delta >= 5 per ~120s pass) are
  both hardcoded constants at the top of `monitor.py` — revisit if the fleet's actual noise/signal
  ratio in Sentry suggests they need tuning once real alerting history accumulates.
- Part A's pm2 registration and Part B's PR/secret are both **host/repo-local actions specific to
  this machine and this owner's GitHub org** — they are not something a fresh clone or a different
  operator's machine would pick up automatically; anyone replicating this setup elsewhere needs to
  re-run the `pm2 start`/`gh secret set` steps for their own environment.

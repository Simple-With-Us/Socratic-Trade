# 2026-07-24 - Coolify/Hetzner runners only + monitor

## Summary

Owner correction: this fleet does **not** rely on GitHub-hosted Actions. CI and review
capacity live on two Coolify-managed Hetzner servers. This change routes workflows onto the
live self-hosted labels, unblocks the orphaned Sentry observer queue, and adds a monitor
script agents should run often.

## Why

- GitHub-hosted `ubuntu-latest` is the wrong path (owner: use the Coolify/Hetzner runners).
- `sentry-ci-report.yml` targeted `[self-hosted, socratic-deploy]`, but **ci-cpx32 has no
  `socratic-deploy` systemd unit / `/opt/actions-runners/socratic-deploy` dir**. Those jobs
  queued forever and clogged the Actions UI.
- Coolify's old Docker `github-runner` compose on the prod host is gone; runners are
  **systemd services** on the dedicated CI box.
- Cleanup/cache + Playwright steps assumed sudo; the `runner` user on ci-cpx32 has no
  passwordless sudo (`gh` missing from PATH until bootstrapped; `--with-deps` fails).

## Architecture (authoritative)

| Server | IP / Coolify | Role |
|--------|--------------|------|
| Prod Coolify host | `<HETZNER_OLD_IP_RETIRED>` (`ubuntu-8gb-hel1-2`, `host.jays.services`) | Coolify control plane, `socratic-trade-prod` deploys, fleet-watchdog. **No** GH Actions runner units. |
| CI build server | `77.42.35.209` (`ci-cpx32`, uuid `<CI_COOLIFY_SERVER_UUID>`) | Fleet systemd runners under `/opt/actions-runners/`: `socratic-ci`, `socratic-ci-2`, `congress-ci`, `shared-ci`, `usage-ci`. |

Socratic labels in use: `socratic-ci` (both CI units register this label). Do not target
`socratic-deploy` or `trading-live` / `trading-live-mac`.

## Files

- `.github/workflows/sentry-ci-report.yml` — `socratic-deploy` -> `socratic-ci`
- `.github/workflows/cleanup-caches.yml` — sudo-free `gh` bootstrap; Coolify-only comment
- `.github/workflows/e2e.yml` — `playwright install chromium` without `--with-deps`
- `.github/actionlint.yaml` — allow only live Coolify labels
- `scripts/monitor-coolify-runners.sh` — Coolify API + GitHub runners + optional SSH
- `scripts/sync-effort-issues.py` — retry 502/503/504
- `AGENTS.md`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md` — two-server + monitor guidance

## Verification

```bash
# Runner inventory + Coolify reachability + workflow label grep + SSH units
export GH_TOKEN="$GITHUB_MCP_TOKEN"; unset GITHUB_TOKEN
CI_SSH_KEY=/tmp/ci_ed25519 bash scripts/monitor-coolify-runners.sh --ssh
# (expects WARN for missing socratic-deploy until a dedicated observer is restored;
#  CRITICAL should be 0 after this PR's workflow fix lands on default branch)

rg -n 'runs-on:.*ubuntu-latest|runs-on:.*socratic-deploy|runs-on:.*trading-live' .github/workflows
# (no matches)

# Cancelled orphaned queued Sentry CI Report runs waiting on missing label (ops, not code)
gh run list --workflow "Sentry CI Report" --status queued --limit 50
```

Also cancelled the stuck queued Sentry CI Report backlog during this session.

## Follow-ups

- Optionally restore a low-duty `socratic-deploy` systemd runner on ci-cpx32 so failure
  telemetry stays off the CI pool; until then keep the reporter on `socratic-ci`.
- Wire `scripts/monitor-coolify-runners.sh --ssh` into an agent cadence / prod cron that can
  reach ci-cpx32 (fleet-watchdog today only watches public app URLs on the prod host).
- Close CONFLICTING PR #2158 in favor of this branch (billing framing was incorrect).
- Preinstall `gh` + Node on the systemd runner images so jobs do not need per-run bootstrap.

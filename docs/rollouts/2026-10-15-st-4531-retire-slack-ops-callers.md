# 2026-10-15 - ST-4531 retire Slack operational callers

## Context & Objective

Fleet coordination moved to Zulip and Agent-Sync.  Socratic-Trade still posted deploy-freshness and provider-knob notices through `slack-sync.sh` and `SLACK_BOT_TOKEN`.  This change routes those operational paths to `agent-sync` and removes Slack from CI and launchd templates.

## Changes Made

- Added `scripts/fleet-ops-notify.sh` and `scripts/fleet-ops-notify.selftest.sh` (Zulip wrapper with dry-run and soft skip when credentials are absent).
- `scripts/alert-deploy-freshness.sh` posts to `#alerts` via fleet-ops-notify (Sentry failure path unchanged).
- `scripts/sync-provider-knobs.sh` posts to `#agent-sync` topic `provider-knobs` on apply.
- `scripts/codex-coordination.sh` uses agent-sync instead of Slack Web API.
- `.github/workflows/deploy-freshness.yml` uses `ZULIP_ST_EMAIL`, `ZULIP_ST_API_KEY`, and `ZULIP_SITE` instead of `SLACK_BOT_TOKEN`.
- `scripts/com.jay.provider-knob-sync.plist` documents CLAUDE Zulip env instead of Slack token.
- `docs/deployment.md`, `.github/workflows/ci.yml`, `.codex/setup.sh` wording updates.

## Decisions & Trade-offs

- Alerts use ASCII `SEVERE | Socratic-Trade | ...` in shell scripts (fleet guide bullets are non-ASCII; operator scripts stay ASCII-only per AGENTS.md).
- `slack-sync.sh` remains in the repo for historical references; operational callers no longer invoke it.
- GitHub optional notices require new repo secrets (`ZULIP_ST_EMAIL`, `ZULIP_ST_API_KEY`, `ZULIP_SITE`); missing secrets behave like missing `SLACK_BOT_TOKEN` (skip with log, job still fails on stale for Sentry).

## Verification State

```bash
bash -n scripts/fleet-ops-notify.sh scripts/fleet-ops-notify.selftest.sh scripts/alert-deploy-freshness.sh scripts/codex-coordination.sh scripts/sync-provider-knobs.sh
bash scripts/fleet-ops-notify.selftest.sh
bash scripts/alert-deploy-freshness.selftest.sh
FLEET_OPS_NOTIFY_DRY_RUN=1 DEPLOY_FRESHNESS_NOTIFY=1 bash scripts/alert-deploy-freshness.sh origin/main  # logs dry-run only when prod fresh
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

1. Owner: add GitHub Actions secrets `ZULIP_ST_EMAIL`, `ZULIP_ST_API_KEY`, and org/repo `ZULIP_SITE` if deploy-freshness should page Zulip (Sentry pages without them).
2. Owner: remove obsolete `SLACK_BOT_TOKEN` from repo secrets when no longer needed elsewhere.

## Zero-Code Findings

None.

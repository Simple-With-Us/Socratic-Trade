# 2026-10-15 - ST-4531 retire Slack operational callers

## Context & Objective

Linear ST-4531: operational automation still posted through `slack-sync.sh` and
`SLACK_BOT_TOKEN` after the fleet Zulip cutover.  Migrate deploy-freshness,
provider-knob sync, and Codex Cloud coordination to `agent-sync` / Zulip while
keeping Sentry failure reporting when production is stale.

## Changes Made

- Added `scripts/fleet-zulip-notify.sh` (safe no-op without credentials;
  `FLEET_NOTIFY_DRY_RUN=1` for selftests).
- `scripts/alert-deploy-freshness.sh` posts to topic `deploy freshness` via the
  helper (Sentry exit codes unchanged).
- `scripts/sync-provider-knobs.sh` posts knob applies to topic `knob sync`.
- `scripts/codex-coordination.sh` uses Zulip (`agent-sync`) instead of Slack Web API.
- `scripts/github-actions-infisical-zulip-ops.sh` — Actions-only Infisical fetch for the ST
  ops Zulip triple (soft-fail).
- `.github/workflows/deploy-freshness.yml` installs fleet coordination and loads the
  ST ops Zulip triple from Infisical `prod` via `github-actions-infisical-zulip-ops.sh`
  (same machine identity as `ios-ship.yml`).  Missing keys keep notify a no-op; the job
  still fails on stale deploys for Sentry.
- Updated `scripts/com.jay.provider-knob-sync.plist`, Codex setup, Claude skills,
  and `docs/deployment.md`.  Marked `scripts/slack-sync.sh` retired for ops posts.

## Decisions & Trade-offs

- Operational posts use `--no-tag` because messages already carry `repo:` lines.
- Provider knob Mac job defaults `FLEET_NOTIFY_SEAT=CLAUDE` to match prior
  `[CLAUDE->FLEET]` prefix behavior.
- Did not delete `slack-sync.sh`; `setup-slack-sync.sh` still needs it for hook
  cleanup only.

## Verification State

```bash
bash -n scripts/fleet-zulip-notify.sh scripts/github-actions-infisical-zulip-ops.sh scripts/alert-deploy-freshness.sh scripts/sync-provider-knobs.sh scripts/codex-coordination.sh
bash scripts/fleet-zulip-notify.selftest.sh
bash scripts/alert-deploy-freshness.selftest.sh
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- **Owner:** ensure Infisical `prod` (ST app project) holds `ZULIP_EMAIL`,
  `ZULIP_API_KEY`, and `ZULIP_SITE` for the ST ops bot if deploy-freshness should page
  `#agent-sync` in addition to Sentry.  No new GitHub repo secrets beyond the existing
  Infisical machine identity.
- **Owner:** Mac provider-knob launchd job needs `~/.secrets/Zulip/Claude-zuliprc`
  (or `ZULIP_RC`) for post-on-change notices.

Fixes ST-4531

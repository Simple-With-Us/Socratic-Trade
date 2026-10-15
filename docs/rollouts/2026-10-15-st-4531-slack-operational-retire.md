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
- `.github/workflows/deploy-freshness.yml` installs fleet coordination and expects
  GitHub Actions secrets `ST_OPS_ZULIP_EMAIL`, `ST_OPS_ZULIP_API_KEY`,
  `ST_OPS_ZULIP_SITE` (ST ops bot).  Missing secrets keep notify a no-op; the job
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
bash -n scripts/fleet-zulip-notify.sh scripts/alert-deploy-freshness.sh scripts/sync-provider-knobs.sh scripts/codex-coordination.sh
bash scripts/fleet-zulip-notify.selftest.sh
bash scripts/alert-deploy-freshness.selftest.sh
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- **Owner:** add GitHub Actions secrets for the ST ops Zulip bot if deploy-freshness
  should page `#agent-sync` in addition to Sentry (`ST_OPS_ZULIP_*`).
- **Owner:** Mac provider-knob launchd job needs `~/.secrets/Zulip/Claude-zuliprc`
  (or `ZULIP_RC`) for post-on-change notices.

Fixes ST-4531

# 2026-10-15 - ST-4531 slack ops callers to Zulip

## Context & Objective

Slack operational alert paths in Socratic-Trade still posted deploy-freshness and provider-knob
notices through `slack-sync.sh` after the fleet hard cut to Zulip.  ST-4531 migrates those senders
to the shared `agent-sync` CLI and `#alerts`, while keeping Sentry failure reporting unchanged.

## Changes Made

- Added `scripts/agent-sync-ops-notify.sh` (+ `agent-sync-ops-notify.selftest.sh`) to format fleet
  alert lines and post with `agent-sync post --channel alerts --no-tag`.
- `scripts/alert-deploy-freshness.sh` and `.github/workflows/deploy-freshness.yml` now use Zulip
  credentials (`ZULIP_OPS_EMAIL`, `ZULIP_OPS_API_KEY`, `ZULIP_SITE`) instead of `SLACK_BOT_TOKEN`.
- `scripts/sync-provider-knobs.sh` and `scripts/com.jay.provider-knob-sync.plist` post knob applies
  via the ops notifier (INFO severity).
- `scripts/codex-coordination.sh` reads/posts through `agent-sync` instead of the Slack Web API.
- `test/slack-ops-retired.test.ts` guards against reintroducing Slack ops senders.
- CI shell gate runs `bash -n` and the ops-notify selftest.

## Decisions & Trade-offs

- Ops cron uses GitHub secrets `ZULIP_OPS_*` for a dedicated ST ops bot; missing secrets keep the
  prior safe no-op behavior (Sentry still pages on workflow failure).
- `slack-sync.sh` remains as a retired engine for hook cleanup only; no production script invokes it.

## Verification State

```bash
bash scripts/agent-sync-ops-notify.selftest.sh
bash scripts/alert-deploy-freshness.selftest.sh
npx vitest run test/slack-ops-retired.test.ts
npm run lint
npx tsc --noEmit
```

`rg` on `scripts` + `.github` finds no `slack-sync.sh` or `slack.com/api` references outside
retirement/installer paths.

## Next Steps & Blockers

- Owner: add GitHub Actions secrets `ZULIP_OPS_EMAIL`, `ZULIP_OPS_API_KEY`, and `ZULIP_SITE` (or
  align names with the live ST ops bot) so deploy-freshness optional notices reach `#alerts`.
- Enable CURSOR (or ST) seat on Agent-Sync MCP Linear tools for cloud claim/closeout if desired.

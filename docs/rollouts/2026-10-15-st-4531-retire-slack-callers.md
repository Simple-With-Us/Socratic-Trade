# 2026-10-15 — ST-4531 retire remaining Socratic-Trade Slack callers

## Context & Objective

Fleet coordination moved to Zulip (`agent-sync`) in October 2026.  A few ST shell scripts and the deploy-freshness workflow still posted via `slack-sync.sh` / `SLACK_BOT_TOKEN`.

## Changes Made

- `scripts/agent-sync-fleet-post.sh` — shared Zulip post helper (no-op without creds).
- `scripts/alert-deploy-freshness.sh`, `scripts/sync-provider-knobs.sh` — use fleet post instead of Slack.
- `scripts/slack-sync.sh` — `post` delegates to Zulip; read/thread remain Slack-gated no-ops without token.
- `scripts/codex-coordination.sh` — retirement stub pointing at `agent-sync`.
- `.github/workflows/deploy-freshness.yml` — drop `SLACK_BOT_TOKEN`; optional `AGENT_SYNC_*` env for Zulip.
- `.claude/skills/pickup-seat/SKILL.md`, `.claude/skills/land-lane/SKILL.md` — Zulip examples.
- `scripts/com.jay.provider-knob-sync.plist` — comment refresh for Zulip creds.
- `scripts/github-actions-infisical-zulip-ops.sh` — Actions-only Infisical fetch for the ST ops Zulip triple (`ZULIP_EMAIL`, `ZULIP_API_KEY`, `ZULIP_SITE`).
- `.github/workflows/deploy-freshness.yml` — install `agent-sync`, load Zulip creds from Infisical prod before optional fleet post.

## Decisions & Trade-offs

- **Single helper (`agent-sync-fleet-post.sh`)** instead of per-script Zulip wiring keeps launchd, cron, and Actions call sites identical and no-op safe when creds are missing.
- **`slack-sync.sh` kept as a stub** (not deleted) so historical docs and any lingering `slack-sync.sh post` invocations degrade to Zulip without resurrecting Slack API code paths; read/thread remain gated no-ops.
- **Deploy-freeze signal stays on Sentry/PagerDuty** via the failing workflow job; Zulip notify is best-effort de-dupe only, matching the pre-ST-4531 Slack optional notify semantics.
- **Infisical at runtime in Actions** reuses the existing machine-identity secrets instead of adding three more GitHub secrets for Zulip; missing keys skip notify without failing the freshness check.

## Verification State

```bash
bash -n scripts/agent-sync-fleet-post.sh scripts/github-actions-infisical-zulip-ops.sh scripts/alert-deploy-freshness.sh scripts/sync-provider-knobs.sh
bash scripts/alert-deploy-freshness.selftest.sh
python3 scripts/test-cloud-coordination-bootstrap.py
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- Merge after `verify` CI green.  Refs ST-4531.

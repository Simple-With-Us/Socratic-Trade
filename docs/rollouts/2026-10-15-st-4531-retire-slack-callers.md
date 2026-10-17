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
- `scripts/github-actions-infisical-zulip-ops.sh` — Actions-only Infisical fetch for the ST ops Zulip triple via `scripts/infisical-secrets-safe.sh get`.
- `scripts/infisical-secrets-safe.sh` — `get` subcommand (GitHub Actions + Zulip-key allowlist only).
- `.github/workflows/deploy-freshness.yml` — install `agent-sync`, load Zulip creds from Infisical prod before optional fleet post.
- `scripts/com.jay.provider-knob-sync.plist` — `AGENT_SYNC_REPO` env; commented Zulip triple template (retired `SLACK_TOPIC`).

## Decisions & Trade-offs

- **Single helper (`agent-sync-fleet-post.sh`)** instead of per-script Zulip wiring keeps launchd, cron, and Actions call sites identical and no-op safe when creds are missing.
- **`slack-sync.sh` kept as a stub** (not deleted) so historical docs and any lingering `slack-sync.sh post` invocations degrade to Zulip without resurrecting Slack API code paths; read/thread remain gated no-ops.
- **Deploy-freeze signal stays on Sentry/PagerDuty** via the failing workflow job; Zulip notify is best-effort de-dupe only, matching the pre-ST-4531 Slack optional notify semantics.
- **Infisical at runtime in Actions** reuses the existing machine-identity secrets instead of adding three more GitHub secrets for Zulip; missing keys skip notify without failing the freshness check.

## Verification State

```bash
bash -n scripts/agent-sync-fleet-post.sh scripts/github-actions-infisical-zulip-ops.sh scripts/infisical-secrets-safe.sh scripts/alert-deploy-freshness.sh scripts/sync-provider-knobs.sh  # -> ok
bash scripts/alert-deploy-freshness.selftest.sh  # -> ok (9/9)
npx vitest run test/infisical-secrets-safe.test.ts  # -> ok (47 passed)
python3 scripts/test-cloud-coordination-bootstrap.py  # -> ok
npm run lint  # -> ok (0 errors, 854 pre-existing warnings)
npx tsc --noEmit  # -> ok
npm test  # -> fail (10 failures, ALL pre-existing on origin/main — see below)
npm run build  # -> ok
```

The `npm test` failures are **not caused by this PR**.  They are confined to
`test/llm-provider.test.ts` and `test/openrouter-credits.test.ts`, neither of which
this branch touches, and they reproduce identically on a clean `origin/main`
worktree (`df7e6d10`) in the same environment — every failing assertion is an
OpenRouter credential present in the runner env that the test assumes is absent.
The authoritative `verify` CI job is the gate for that.

## Next Steps & Blockers

- Landed on `main` via PR #4696 (2026-10-15).  Follow-up PR clears merge-conflict markers that were committed in this rollout file on `main` and adds regression tests for rule 49 + `agent-sync post` flags.

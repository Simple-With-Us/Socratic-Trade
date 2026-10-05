# 2026-10-05 — Cursor cloud environment Kody review (PR #4178)

## Context & Objective

Harden the Cursor cloud agent environment on branch `plumber/cursor-cloud-env` per Kody review
threads on PR #4178: no hardcoded Infisical project ids, no on-disk secret materialization, no
committed `.env`-style parsing in start hooks, safe behavior when Infisical credentials are absent,
and honest fleet coordination wiring for Linux cloud VMs.

## Changes Made

- `.cursor/infisical.env` — reference-only defaults (`INFISICAL_ENV`, `INFISICAL_DOMAIN`); not read
  by `scripts/cursor-cloud-start.sh`.  Project UUIDs and client credentials belong in Cursor
  dashboard Secrets (`INFISICAL_PROJECT_ID`, optional shared overlay ids + shared client credentials).
- `scripts/cursor-cloud-start.sh` — probe for an in-repo relay consumer/poller bootstrap (soft-fail
  with a documented gap today); optional Slack SessionStart hook; Infisical smoke-test via
  `infisical-run.mjs` only when dashboard env is present.
- `scripts/cursor-cloud-install.sh` — `load_nvm` sources `nvm.sh` with `--no-use` under relaxed
  `errexit`/`nounset`; `nvm install`/`nvm use` fail-soft; Infisical bootstrap check and optional
  Slack hook like `cloud-setup.sh`.

## Decisions & Trade-offs

- **Relay consumer/poller:** This repo has no Linux fleet relay consumer/poller script yet.  Mac
  seats attach via pm2 `agent-sync-push` (Socket Mode fan-out), which does not run on Cursor cloud
  VMs.  `cursor-cloud-start.sh` runs the first matching bootstrap under
  `scripts/agent-sync-relay-*.sh` when one lands; otherwise it logs a known gap and continues.
  `scripts/setup-slack-sync.sh` remains **optional** `#agent-sync` read/post coordination only; it
  does **not** satisfy the relay attachment rule and is not documented as a substitute.
- **Secrets:** Strict Infisical policy — agents use `npm run dev:secrets` / `infisical-run.mjs`;
  the start hook only validates wiring when dashboard credentials exist.  No loader reads
  `.cursor/infisical.env` or other committed env files.

## Verification State

Shell-only review for this PR (install/start hooks and rollout doc).  Application build gates were
**not run** — not applicable to these changes.

```bash
bash -n scripts/cursor-cloud-start.sh   # exit 0
bash -n scripts/cursor-cloud-install.sh # exit 0
```

## Next Steps & Blockers

- Review seat: resolve remaining Kody threads on PR #4178 after verifying pushed commits.
- Operator: set `INFISICAL_PROJECT_ID` (and optional shared overlay secrets) in Cursor dashboard.
- Fleet: add a Linux in-repo relay consumer/poller bootstrap when cloud seats must attach to the
  sanctioned relay path (today: documented gap).

## Zero-Code Findings

None.

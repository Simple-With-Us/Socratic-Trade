# 2026-10-05 — Cursor cloud environment Kody review (PR #4178)

## Context & Objective

Harden the Cursor cloud agent environment on branch `plumber/cursor-cloud-env` per nine
unresolved Kody review threads on PR #4178: no hardcoded Infisical project ids, no on-disk
secret materialization, safe behavior when Infisical credentials are absent, and parity with
`scripts/cloud-setup.sh` coordination bootstrap.

## Changes Made

- `.cursor/infisical.env` — commit only `INFISICAL_ENV` and `INFISICAL_DOMAIN`; project UUIDs
  must be supplied via Cursor dashboard Secrets (`INFISICAL_PROJECT_ID`, optional shared overlay
  ids + shared client credentials).
- `scripts/cursor-cloud-start.sh` — install Slack SessionStart hook first; load only safe
  defaults; unset shared project selectors unless shared client id+secret exist; smoke-test
  `infisical-run.mjs` without writing `$HOME` dotenv files or enumerating env to stdout.
- `scripts/cursor-cloud-install.sh` — source `nvm.sh` before using `nvm`; add Infisical
  bootstrap check and `setup-slack-sync.sh` like `cloud-setup.sh`.

## Decisions & Trade-offs

- **Relay consumer/poller:** Linux Cursor cloud VMs do not run the Mac `agent-sync-push` Socket
  Mode daemon.  The prescribed coordination path for cloud seats is `scripts/setup-slack-sync.sh`
  (SessionStart hook + `scripts/slack-sync.sh`), already used by `scripts/cloud-setup.sh`.
- **Secrets:** Strict Infisical policy — agents use `npm run dev:secrets` / `infisical-run.mjs`;
  the start hook only validates wiring when dashboard credentials exist.

## Verification State

```bash
bash -n scripts/cursor-cloud-start.sh
bash -n scripts/cursor-cloud-install.sh
```

## Next Steps & Blockers

- Review seat: resolve Kody threads on PR #4178 after verifying pushed commits.
- Operator: set `INFISICAL_PROJECT_ID` (and optional shared overlay secrets) in Cursor dashboard.

## Zero-Code Findings

None.

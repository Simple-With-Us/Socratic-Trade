# 2026-06-22 - cloud-env-setup

## Summary

- Added version-controlled setup config so a fresh/isolated checkout (Claude Code
  cloud or remote sandbox, GitHub Codespaces, devcontainer, or any throwaway
  clone) has a defined bootstrap instead of falling back to an undefined default.
- New files:
  - `.nvmrc` → `24` (matches the owner's local `v24.16.0`; aligns local/cloud Node).
  - `scripts/cloud-setup.sh` → idempotent: `npm ci`, then non-destructively seed
    `.env.local` from `.env.example` if absent; prints run/verify next steps.
  - `.devcontainer/devcontainer.json` → Node 24 image, `postCreateCommand: bash
    scripts/cloud-setup.sh`, forwards port 3000, sets `DATABASE_URL` default.

## Why

- Investigated a Claude Code **cloud agent** that hung for hours on the first
  step ("Setting up a cloud container") for this repo. Root finding for the
  *setup* gap: the repo had **no** `.devcontainer`, no `setup`/`postinstall` in
  `package.json`, and an empty `.claude/settings.json` — so the cloud/remote
  "Run setup script" step had nothing project-defined to run. (The hang itself
  was at container provisioning, before clone/setup — an Anthropic-hosted infra
  step, not a repo issue; likely a backend incident or an orphaned session.)
- The app boots **keyless in Test mode** (local SQLite at `data/app.db`), so the
  canonical setup is just `npm ci`; secrets are optional (`OPENAI_API_KEY` only
  for the LLM "Run once"/decide loop). Encoded that as the single source of truth.

## Files

- `.nvmrc`
- `scripts/cloud-setup.sh`
- `.devcontainer/devcontainer.json`
- `STATUS.md`
- `docs/rollouts/2026-06-22-cloud-env-setup.md`

## Verification

- `bash -n scripts/cloud-setup.sh` (syntax check) — clean.
- No TypeScript/source changed (config + shell + docs only), so the local
  tsc/test/build trio was not re-run here; the required `verify` CI check runs
  the full `tsc --noEmit` → `npm test` → `npm run build` on the PR and gates the
  merge.

## Follow-ups

- **Owner action (UI, not code):** in the Claude Code new-session **Cloud**
  environment settings, set the setup-script field to `bash scripts/cloud-setup.sh`.
  These repo files only reach a cloud/remote clone after this branch merges to
  `main` (cloud clones from GitHub, not local disk).
- Per-environment launcher settings (setup-script string, secrets, repo/branch)
  live in the app/account UI and are not editable by any Claude session — only
  the repo-side config (these files) is automatable.
- Optional: add an `engines.node` field to `package.json` if stricter Node
  pinning is desired (kept out for now to avoid install friction).

## Blockers

- None.

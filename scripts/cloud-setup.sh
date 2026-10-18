#!/usr/bin/env bash
# Canonical setup for a fresh, isolated checkout (Claude Code cloud/remote sandbox,
# Codespaces, devcontainer, or any throwaway clone). Idempotent - safe to re-run.
#
# IMPORTANT (Claude Code Cloud environments specifically): the container's working
# directory when the "Setup script" field runs is the PARENT of the cloned repo
# (e.g. /home/user), NOT the repo root - `git clone` creates a `Socratic-Trade/`
# subdirectory and the sandbox drops you one level above it. A bare
# `bash scripts/cloud-setup.sh` therefore fails with
# `bash: scripts/cloud-setup.sh: No such file or directory` (exit 127) because
# that path doesn't resolve from the parent directory.
#
# Point the environment's Setup script field at the fleet locator (works for
# every app; see ai-fleet-coordinator/docs/CLAUDE-CODE-CLOUD-ENVIRONMENTS.md):
#   set -euo pipefail
#   if [ -f scripts/cloud-setup.sh ]; then exec bash scripts/cloud-setup.sh; fi
#   shopt -s nullglob
#   matches=(*/scripts/cloud-setup.sh)
#   if [ "${#matches[@]}" -eq 1 ]; then exec bash "${matches[0]}"; fi
#   echo "ERROR: scripts/cloud-setup.sh not found from $(pwd)" >&2; ls -la >&2; exit 1
#
# Equivalent one-liner if you prefer the repo name:
#   cd Socratic-Trade && bash scripts/cloud-setup.sh
#
# (`.devcontainer/devcontainer.json`'s `postCreateCommand` does NOT need the `cd`
# - devcontainers set `workspaceFolder` to the repo root automatically. This `cd`
# is only required for the plain Claude Code Cloud "Setup script" text field.)
#
# The app boots keyless: local SQLite at data/app.db is infrastructure (settings,
# proposals, users), not an execution mode. No secrets are required for the UI,
# Market Scan, or watchlist/policy/account configuration. Inject OPENAI_API_KEY
# only if you want the LLM "Run once" / decide loop; placing orders requires a
# connected broker account (paper or live) - there is no local-simulation fallback.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# Deterministic install from the committed lockfile.
echo "==> Installing dependencies (npm ci)"
npm ci

# Resolve the local Infisical machine-identity bootstrap (process env, then the
# macOS login Keychain, service socratic-trade-bootstrap) without copying or
# printing credential values. The runner repeats this resolution at launch.
# The flat ~/.secrets/global-api-keys file is retired and never read (owner,
# 2026-10-18, OPS-818). An inherited legacy GLOBAL_API_KEYS_FILE is ignored.
# Cloud VMs have no Keychain — missing identities are expected; do not fail
# setup for a keyless checkout.
unset GLOBAL_API_KEYS_FILE
echo "==> Checking Infisical bootstrap identity (values stay private)"
# Cloud VMs have no Keychain items. Missing identities are expected; do not fail the whole session setup for a keyless checkout.
node scripts/infisical-bootstrap-env.mjs || echo "==> Infisical bootstrap skipped (ok in keyless cloud)"

# Bootstrap the fleet coordination CLIs (board for Linear, agent-sync for Zulip)
# into ~/.local/bin. Product setup may continue offline; fleet work must wait
# until the installed protocol and both CLI identity checks are available.
echo "==> Installing fleet coordination CLIs (board, agent-sync)"
bash scripts/install-fleet-coordination.sh || echo "==> Fleet coordination unavailable; stop fleet work until setup and identity checks pass"

echo "==> Setup complete. Start the app with: npm run dev:secrets   (Infisical runner on :3000)"
echo "    'npm run dev' (plain) is for tests-only — it no longer reads .env.local."
echo "    Verify a change with: npx tsc --noEmit && npm test && npm run build"

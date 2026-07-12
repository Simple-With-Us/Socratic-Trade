#!/usr/bin/env bash
# Canonical setup for a fresh, isolated checkout (Claude Code cloud/remote sandbox,
# Codespaces, devcontainer, or any throwaway clone). Idempotent - safe to re-run.
#
# Point your environment's "setup script" field at this file:
#   bash scripts/cloud-setup.sh
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

# Give the sandbox explicit, safe defaults + a place for injected secrets.
# Non-destructive: never clobber an existing .env.local.
if [ ! -f .env.local ] && [ -f .env.example ]; then
  echo "==> Seeding .env.local from .env.example (keys blank)"
  cp .env.example .env.local
fi

# Install the Slack coordination sync globally (SessionStart hook). No-op at
# runtime unless SLACK_BOT_TOKEN is set as an environment secret. Non-fatal:
# a hiccup here must never fail the whole environment setup.
echo "==> Installing Slack coordination sync (global SessionStart hook)"
bash scripts/setup-slack-sync.sh || echo "    (slack-sync install skipped; see docs/slack-coordination.md)"

echo "==> Setup complete. Start the app with: npm run dev   (Next.js on :3000)"
echo "    Verify a change with: npx tsc --noEmit && npm test && npm run build"

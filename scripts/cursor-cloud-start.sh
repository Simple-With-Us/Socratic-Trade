#!/usr/bin/env bash
# Cursor cloud agent start for Socratic-Trade.
# 1. Attach fleet relay consumer/poller when an in-repo Linux bootstrap exists
#    (soft-fail with a documented gap otherwise; Slack is optional coordination only).
# 2. Infisical selectors come from process environment / Cursor dashboard Secrets only
#    (strict Infisical: no parsing committed .env-shaped files in this hook).
# 3. When dashboard credentials exist, smoke-test scripts/infisical-run.mjs without writing
#    secrets to disk.  Agents load secrets through npm run dev:secrets / infisical-run.mjs.
# 4. Missing credentials: log secret NAMES only and exit 0 so the VM boot succeeds.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()   { printf '[cursor-cloud-start] %s\n' "$*"; }
warn()  { printf '[cursor-cloud-start] WARN: %s\n' "$*" >&2; }

# Known in-repo relay bootstrap scripts (first match wins).  There is no Linux consumer
# in this repo today; Mac seats run pm2 agent-sync-push outside the tree.
RELAY_BOOTSTRAP_CANDIDATES=(
  scripts/agent-sync-relay-consumer.sh
  scripts/agent-sync-relay-poller.sh
  scripts/agent-sync-push-consumer.sh
)

attach_fleet_relay_consumer() {
  local script rel
  for rel in "${RELAY_BOOTSTRAP_CANDIDATES[@]}"; do
    script="${REPO_ROOT}/${rel}"
    if [[ -f "${script}" ]]; then
      log "Attaching fleet relay via ${rel}"
      if bash "${script}" >/dev/null 2>&1; then
        log "Fleet relay consumer bootstrap completed."
      else
        warn "Fleet relay bootstrap ${rel} failed; continuing cloud start."
      fi
      return 0
    fi
  done
  warn "No in-repo Linux fleet relay consumer/poller script found (known gap)."
  warn "Mac agent-sync-push is not available on Cursor cloud VMs."
  return 0
}

attach_fleet_relay_consumer

# Optional #agent-sync coordination (SessionStart hook).  Not a substitute for relay.
if [[ -f scripts/setup-slack-sync.sh ]]; then
  if bash scripts/setup-slack-sync.sh >/dev/null 2>&1; then
    log "Optional Slack coordination hook installed (no-op without SLACK_BOT_TOKEN)."
  else
    warn "setup-slack-sync.sh skipped; optional coordination hook not updated."
  fi
else
  warn "scripts/setup-slack-sync.sh missing; skipping optional Slack coordination."
fi

# Do not enter the shared overlay branch unless shared machine identity is present.
if [[ -z "${INFISICAL_SHARED_CLIENT_ID:-}" || -z "${INFISICAL_SHARED_CLIENT_SECRET:-}" ]]; then
  unset INFISICAL_SHARED_PROJECT_ID INFISICAL_SHARED_TOKEN \
    INFISICAL_SHARED_CLIENT_ID INFISICAL_SHARED_CLIENT_SECRET 2>/dev/null || true
fi

# Dashboard secrets -- NAMES only, never values.
missing=()
[[ -z "${INFISICAL_CLIENT_ID:-}" ]]     && missing+=("INFISICAL_CLIENT_ID")
[[ -z "${INFISICAL_CLIENT_SECRET:-}" ]] && missing+=("INFISICAL_CLIENT_SECRET")

if (( ${#missing[@]} > 0 )); then
  warn "Missing Cursor dashboard secrets: ${missing[*]}"
  warn "Add these names in the Cursor environment Secrets UI (values are never logged)."
  warn "Skipping Infisical smoke test; use npm run dev:secrets when credentials are set."
  exit 0
fi

if [[ -z "${INFISICAL_PROJECT_ID:-}" ]]; then
  warn "INFISICAL_PROJECT_ID is not set (Cursor dashboard or operator config)."
  warn "Skipping Infisical smoke test; npm run dev:secrets needs a project id."
  exit 0
fi

# Smoke-test the in-repo runner (secrets stay in the child process; no .env files).
if [[ ! -f scripts/infisical-run.mjs ]]; then
  warn "scripts/infisical-run.mjs missing; cannot validate Infisical wiring."
  exit 0
fi

if node ./scripts/infisical-run.mjs -- node -e "process.exit(0)" >/dev/null 2>&1; then
  log "Infisical runner smoke test passed (secrets not written to disk)."
else
  warn "Infisical runner smoke test failed; check dashboard secrets and project id."
  warn "Boot continues; fix credentials before npm run dev:secrets."
fi

log "start complete."

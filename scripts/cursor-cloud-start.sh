#!/usr/bin/env bash
# Cursor cloud agent start for Socratic-Trade.
# 1. Attach Slack coordination (SessionStart hook via setup-slack-sync.sh) -- same path as
#    scripts/cloud-setup.sh; there is no Mac-side agent-sync-push relay on Linux cloud VMs.
# 2. Load non-secret Infisical defaults from .cursor/infisical.env (ENV / DOMAIN only).
# 3. When dashboard credentials exist, smoke-test scripts/infisical-run.mjs without writing
#    secrets to disk.  Agents load secrets through npm run dev:secrets / infisical-run.mjs.
# 4. Missing credentials: log secret NAMES only and exit 0 so the VM boot succeeds.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()   { printf '[cursor-cloud-start] %s\n' "$*"; }
warn()  { printf '[cursor-cloud-start] WARN: %s\n' "$*" >&2; }

# 1. Fleet coordination relay (read/post path for #agent-sync at session start).
if [[ -f scripts/setup-slack-sync.sh ]]; then
  if bash scripts/setup-slack-sync.sh >/dev/null 2>&1; then
    log "Slack coordination hook installed (no-op without SLACK_BOT_TOKEN)."
  else
    warn "setup-slack-sync.sh skipped; coordination hook not updated."
  fi
else
  warn "scripts/setup-slack-sync.sh missing; skipping coordination hook install."
fi

# 2. Committed defaults only -- never project UUIDs (dashboard supplies those).
if [[ -f .cursor/infisical.env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" ]] && continue
    case "$line" in
      INFISICAL_ENV=*|INFISICAL_DOMAIN=*|INFISICAL_PATH=*)
        key="${line%%=*}"
        if [[ -z "${!key:-}" ]]; then
          export "$line"
        fi
        ;;
    esac
  done < .cursor/infisical.env
  log "Loaded Infisical defaults from .cursor/infisical.env (no project ids)."
else
  warn ".cursor/infisical.env missing; relying on Cursor dashboard env only."
fi

# Do not enter the shared overlay branch unless shared machine identity is present.
if [[ -z "${INFISICAL_SHARED_CLIENT_ID:-}" || -z "${INFISICAL_SHARED_CLIENT_SECRET:-}" ]]; then
  unset INFISICAL_SHARED_PROJECT_ID INFISICAL_SHARED_TOKEN \
    INFISICAL_SHARED_CLIENT_ID INFISICAL_SHARED_CLIENT_SECRET 2>/dev/null || true
fi

# 3. Dashboard secrets -- NAMES only, never values.
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

# 4. Smoke-test the in-repo runner (secrets stay in the child process; no .env files).
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

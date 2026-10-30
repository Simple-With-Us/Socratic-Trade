#!/usr/bin/env bash
# Cursor cloud agent install for Socratic-Trade.
# Idempotent on Ubuntu.  Skip macOS / iOS / Xcode (those are Mac-only and the
# iOS path is exercised by GitHub-hosted ios-build.yml, not by Cursor cloud).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '[cursor-cloud-install] %s\n' "$*"; }
warn() { printf '[cursor-cloud-install] WARN: %s\n' "$*" >&2; }

load_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local nvm_sh="${nvm_dir}/nvm.sh"
  if [[ ! -s "${nvm_sh}" ]]; then
    return 1
  fi
  set +e
  set +u
  # shellcheck disable=SC1091
  # nvm is a shell function; non-interactive bash never has `command -v nvm` true
  # until nvm.sh is sourced.  Upstream recommends --no-use to avoid default-alias
  # activation side effects under strict mode.
  if ! . "${nvm_sh}" --no-use 2>/dev/null; then
    if ! . "${nvm_sh}" 2>/dev/null; then
      set -euo pipefail
      return 1
    fi
  fi
  set -euo pipefail
  return 0
}

# macOS / iOS / Xcode are not supported on Cursor cloud (Linux).  Fail soft if
# anyone is on Darwin so this script still exits 0 on a Mac dev seat.
if [[ "$(uname -s)" == "Darwin" ]]; then
  warn "macOS detected; skipping npm ci.  Use a Mac seat with Xcode for iOS work."
  exit 0
fi

# 1. Node toolchain -- match .nvmrc (26) when nvm is installed on the image.
NODE_REQUIRED="26"
NODE_CURRENT="$(node -v 2>/dev/null || echo "none")"
if [[ "$NODE_CURRENT" == "none" || "$NODE_CURRENT" != v${NODE_REQUIRED}.* ]]; then
  if load_nvm && type nvm >/dev/null 2>&1; then
    log "Installing Node ${NODE_REQUIRED}.x via nvm"
    if ! nvm install "${NODE_REQUIRED}" >/dev/null; then
      warn "nvm install ${NODE_REQUIRED} failed; continuing with current node ${NODE_CURRENT}"
    elif ! nvm use "${NODE_REQUIRED}" >/dev/null; then
      warn "nvm use ${NODE_REQUIRED} failed; continuing with current node"
    fi
  elif command -v volta >/dev/null 2>&1; then
    log "Pinning Node ${NODE_REQUIRED}.x via volta"
    volta pin node@"${NODE_REQUIRED}" >/dev/null
  else
    warn "No nvm / volta found and current node is ${NODE_CURRENT}; expected ${NODE_REQUIRED}.x."
    warn "Install Node ${NODE_REQUIRED}.x and re-run, or rely on the Cursor cloud base image."
  fi
fi

# 2. npm ci (idempotent; reuses cached install on agent resume).
if [[ -f package-lock.json ]]; then
  log "Running: npm ci"
  npm ci --no-audit --no-fund --prefer-offline
else
  warn "package-lock.json missing; skipping npm ci."
fi

# 3. Infisical bootstrap check (values stay private; ok when keyless).
if [[ -f scripts/infisical-bootstrap-env.mjs ]]; then
  log "Checking Infisical bootstrap identity (values stay private)"
  node scripts/infisical-bootstrap-env.mjs >/dev/null 2>&1 || warn "Infisical bootstrap skipped (ok in keyless cloud)"
fi

# 4. Sanity-check the existing in-repo Infisical helper without invoking it.
if [[ -f scripts/infisical-run.mjs ]]; then
  log "Found scripts/infisical-run.mjs -- start script will smoke-test it when creds exist."
else
  warn "scripts/infisical-run.mjs missing; Infisical injection unavailable."
fi

# 5. Bootstrap the fleet coordination CLIs (board for Linear, agent-sync for Zulip)
# into ~/.local/bin.  Product setup may continue offline; fleet work waits
# until the installed protocol and both CLI identity checks are available.
if [[ -f scripts/install-fleet-coordination.sh ]]; then
  log "Installing fleet coordination CLIs (board, agent-sync)"
  bash scripts/install-fleet-coordination.sh || warn "Fleet coordination unavailable; stop fleet work until setup and identity checks pass"
else
  warn "scripts/install-fleet-coordination.sh missing; coordination CLIs not bootstrapped."
fi

log "install complete."

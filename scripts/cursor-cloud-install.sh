#!/usr/bin/env bash
# Cursor cloud agent install for Socratic-Trade.
# Idempotent on Ubuntu.  Skip macOS / iOS / Xcode (those are Mac-only and the
# iOS path is exercised by GitHub-hosted ios-build.yml, not by Cursor cloud).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '[cursor-cloud-install] %s\n' "$*"; }
warn() { printf '[cursor-cloud-install] WARN: %s\n' "$*" >&2; }

# macOS / iOS / Xcode are not supported on Cursor cloud (Linux).  Fail soft if
# anyone is on Darwin so this script still exits 0 on a Mac dev seat.
if [[ "$(uname -s)" == "Darwin" ]]; then
  warn "macOS detected; skipping npm ci.  Use a Mac seat with Xcode for iOS work."
  exit 0
fi

# 1. Node toolchain -- match .nvmrc (24).
if command -v nvm >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" || true
fi

NODE_REQUIRED="24"
NODE_CURRENT="$(node -v 2>/dev/null || echo "none")"
if [[ "$NODE_CURRENT" == "none" || "$NODE_CURRENT" != v${NODE_REQUIRED}.* ]]; then
  if command -v nvm >/dev/null 2>&1; then
    log "Installing Node ${NODE_REQUIRED}.x via nvm"
    nvm install "${NODE_REQUIRED}" >/dev/null
    nvm use "${NODE_REQUIRED}" >/dev/null
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

# 3. Sanity-check the existing in-repo Infisical helper without invoking it.
if [[ -f scripts/infisical-run.mjs ]]; then
  log "Found scripts/infisical-run.mjs -- start script will reuse it."
else
  warn "scripts/infisical-run.mjs missing; start script will fall back to infisical CLI."
fi

log "install complete."
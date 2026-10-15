#!/usr/bin/env bash
# github-actions-infisical-zulip-ops.sh - load ST ops Zulip triple for agent-sync from Infisical.
#
# Uses the repo's existing Infisical machine identity (INFISICAL_PROJECT_ID +
# universal-auth client id/secret in GitHub Actions secrets).  Values live in
# Infisical prod only; this script never fails the job when login or keys are
# missing (deploy-freshness Zulip notify stays a no-op).
#
# Writes ZULIP_EMAIL, ZULIP_API_KEY, ZULIP_SITE to GITHUB_ENV when all three are
# present.  Keep pure ASCII (AGENTS.md: operator shell scripts).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFISICAL_SAFE="${SCRIPT_DIR}/infisical-secrets-safe.sh"

INFISICAL_CLI_VERSION="${INFISICAL_CLI_VERSION:-0.43.98}"
BIN_DIR="${GITHUB_ACTIONS_INFISICAL_BIN:-${GITHUB_WORKSPACE:-.}/.ci-bin}"

log() { printf '[infisical-zulip-ops] %s\n' "$*" >&2; }

skip() {
  log "$1"
  exit 0
}

if [ -z "${GITHUB_ENV:-}" ]; then
  skip "GITHUB_ENV unset; not running in Actions (skip)."
fi

install_cli() {
  if command -v infisical >/dev/null 2>&1; then
    return 0
  fi
  mkdir -p "$BIN_DIR"
  local arch tarball dest
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) skip "unsupported arch for Infisical CLI: $arch" ;;
  esac
  tarball="${BIN_DIR}/infisical-cli.tgz"
  dest="${BIN_DIR}/infisical"
  if [ ! -x "$dest" ]; then
    curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 \
      -o "$tarball" \
      "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${arch}.tar.gz" \
      || skip "Infisical CLI download failed (Zulip notify disabled)."
    tar -xzf "$tarball" -C "$BIN_DIR" infisical 2>/dev/null \
      || tar -xzf "$tarball" -C "$BIN_DIR" 2>/dev/null \
      || skip "Infisical CLI extract failed (Zulip notify disabled)."
    chmod +x "$dest" 2>/dev/null || true
  fi
  export PATH="${BIN_DIR}:${PATH}"
  command -v infisical >/dev/null 2>&1 || skip "Infisical CLI not on PATH (Zulip notify disabled)."
}

install_cli
export INFISICAL_DISABLE_UPDATE_CHECK=true

if [ -z "${INFISICAL_PROJECT_ID:-}" ]; then
  skip "INFISICAL_PROJECT_ID unset (Zulip notify disabled)."
fi

CLIENT_ID="${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}"
CLIENT_SECRET="${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}"
if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  CLIENT_ID="${INFISICAL_CLIENT_ID:-}"
  CLIENT_SECRET="${INFISICAL_CLIENT_SECRET:-}"
fi
if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  skip "Infisical machine identity unset (Zulip notify disabled)."
fi

TOKEN="$(
  env -u INFISICAL_CLIENT_ID -u INFISICAL_CLIENT_SECRET -u INFISICAL_TOKEN \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$CLIENT_ID" \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$CLIENT_SECRET" \
    infisical login --method=universal-auth --silent --plain --telemetry=false 2>/dev/null || true
)"
if [ -z "$TOKEN" ]; then
  skip "Infisical universal-auth login failed (Zulip notify disabled)."
fi
if [[ "$TOKEN" == *$'\n'* || "$TOKEN" == *$'\r'* ]]; then
  skip "Infisical returned a multiline token (Zulip notify disabled)."
fi
printf '::add-mask::%s\n' "${TOKEN//'%'/'%25'}"

fetch_one() {
  local name="$1"
  [ -x "$INFISICAL_SAFE" ] || skip "infisical-secrets-safe.sh missing (Zulip notify disabled)."
  GITHUB_ACTIONS=true INFISICAL_TOKEN="$TOKEN" "$INFISICAL_SAFE" get "$name" \
    --projectId="$INFISICAL_PROJECT_ID" --env=prod --path=/ \
    2>/dev/null || true
}

EMAIL=""
KEY=""
SITE=""
for name in ZULIP_EMAIL ZULIP_API_KEY ZULIP_SITE; do
  val="$(fetch_one "$name")"
  if [ -z "$val" ]; then
    skip "Infisical prod missing $name (Zulip notify disabled)."
  fi
  if [[ "$val" == *$'\n'* || "$val" == *$'\r'* ]]; then
    skip "Infisical $name must be single-line (Zulip notify disabled)."
  fi
  printf '::add-mask::%s\n' "${val//'%'/'%25'}"
  case "$name" in
    ZULIP_EMAIL) EMAIL="$val" ;;
    ZULIP_API_KEY) KEY="$val" ;;
    ZULIP_SITE) SITE="$val" ;;
  esac
done

{
  printf 'ZULIP_EMAIL=%s\n' "$EMAIL"
  printf 'ZULIP_API_KEY=%s\n' "$KEY"
  printf 'ZULIP_SITE=%s\n' "$SITE"
} >>"$GITHUB_ENV"
log "loaded ST ops Zulip credentials from Infisical prod."

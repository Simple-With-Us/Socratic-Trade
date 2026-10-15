#!/usr/bin/env bash
# fleet-ops-notify.sh - machine operational notices on Zulip via agent-sync.
#
# Replaces slack-sync.sh for deploy-freshness, provider-knob sync, and similar
# automation.  Interactive seat coordination uses agent-sync directly.
#
# Usage:
#   scripts/fleet-ops-notify.sh post <text...>
#   scripts/fleet-ops-notify.sh test
#   scripts/fleet-ops-notify.sh help
#
# Environment:
#   AGENT_SEAT                 Bot seat (default ST)
#   FLEET_OPS_NOTIFY_CHANNEL   Zulip channel (default alerts)
#   FLEET_OPS_NOTIFY_TOPIC     Topic (default Socratic-Trade)
#   FLEET_OPS_NOTIFY_DRY_RUN=1 Log only; do not call agent-sync
#   ZULIP_RC or ZULIP_EMAIL+ZULIP_API_KEY+ZULIP_SITE (agent-sync rules)
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

AGENT_SEAT="${AGENT_SEAT:-ST}"
CHANNEL="${FLEET_OPS_NOTIFY_CHANNEL:-alerts}"
TOPIC="${FLEET_OPS_NOTIFY_TOPIC:-Socratic-Trade}"
DRY_RUN="${FLEET_OPS_NOTIFY_DRY_RUN:-0}"

log() { printf '[fleet-ops-notify] %s\n' "$*" >&2; }

resolve_agent_sync() {
  if command -v agent-sync >/dev/null 2>&1; then
    command -v agent-sync
    return 0
  fi
  if [ -x "${HOME}/.local/bin/agent-sync" ]; then
    printf '%s\n' "${HOME}/.local/bin/agent-sync"
    return 0
  fi
  return 1
}

has_zulip_credentials() {
  if [ -n "${ZULIP_RC:-}" ] && [ -r "${ZULIP_RC}" ]; then
    return 0
  fi
  if [ -n "${ZULIP_EMAIL:-}" ] && [ -n "${ZULIP_API_KEY:-}" ] && [ -n "${ZULIP_SITE:-}" ]; then
    return 0
  fi
  local seat_file="${HOME}/.secrets/Zulip/${AGENT_SEAT}-zuliprc"
  if [ -r "$seat_file" ]; then
    return 0
  fi
  return 1
}

format_body() {
  # Zulip fleet guide: widen gaps after sentence ends before posting.
  printf '%s' "$1" | perl -CSDA -pe 's/([.!?])  (?=\S)/$1\x{a0} /g'
}

post_message() {
  local text="$1"
  local cli body
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run: would post to #${CHANNEL} > ${TOPIC}: ${text}"
    return 0
  fi
  if ! has_zulip_credentials; then
    log "notify skipped (no Zulip credentials for seat ${AGENT_SEAT})."
    return 0
  fi
  cli="$(resolve_agent_sync)" || {
    log "notify skipped (agent-sync not installed)."
    return 0
  }
  body="$(format_body "$text")"
  if ! AGENT_SEAT="$AGENT_SEAT" "$cli" --as "$AGENT_SEAT" post \
      --channel "$CHANNEL" --topic "$TOPIC" --no-tag "$body" >/dev/null 2>&1; then
    log "warn: agent-sync post failed (credentials or Zulip error)."
    return 0
  fi
  log "ok: posted to #${CHANNEL} > ${TOPIC}"
}

cmd_test() {
  local cli
  cli="$(resolve_agent_sync)" || { log "agent-sync: MISSING"; exit 1; }
  if ! has_zulip_credentials; then
    log "Zulip: credentials not configured for seat ${AGENT_SEAT}"
    exit 2
  fi
  AGENT_SEAT="$AGENT_SEAT" "$cli" --as "$AGENT_SEAT" whoami >/dev/null \
    || { log "Zulip: FAILED"; exit 1; }
  echo "Zulip: OK"
  if [ -n "${GH_TOKEN:-}" ]; then
    gh api user --jq .login >/dev/null 2>&1 && echo "GitHub: OK" \
      || { log "GitHub: FAILED"; exit 1; }
  else
    echo "GitHub: GH_TOKEN is not a runtime environment variable." >&2
    exit 2
  fi
}

cmd_help() {
  sed -n '2,22p' "$0"
  echo "  test                 verify Zulip + optional GitHub"
}

case "${1:-help}" in
  post)
    shift
    [ $# -gt 0 ] || { log "usage: $0 post <text...>"; exit 2; }
    post_message "$*"
    ;;
  test)
    cmd_test
    ;;
  help|-h|--help)
    cmd_help
    ;;
  *)
    log "unknown command: ${1:-}"
    cmd_help
    exit 2
    ;;
esac

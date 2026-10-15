#!/usr/bin/env bash
# fleet-zulip-notify.sh - operational notices on Zulip #agent-sync via agent-sync.
#
# Replaces direct slack-sync.sh posts from cron/CI/Mac automation.  Coordination
# claims still use agent-sync directly; this helper is for scripts that need a
# safe no-op when credentials are absent.
#
# Usage:
#   scripts/fleet-zulip-notify.sh post --topic TOPIC [--channel C] [--as SEAT] [--no-tag] <text...>
#   scripts/fleet-zulip-notify.sh test
#
# Env:
#   FLEET_NOTIFY_DRY_RUN=1     log the post, do not call Zulip (selftests)
#   FLEET_NOTIFY_SEAT / AGENT_SEAT   seat for credentials (default ST)
#   ZULIP_RC or ZULIP_EMAIL + ZULIP_API_KEY + ZULIP_SITE (agent-sync resolver)
#
# Exit: 0 on success or intentional skip (missing creds); nonzero on agent-sync error.
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL_DEFAULT="${FLEET_NOTIFY_CHANNEL:-agent-sync}"
SEAT_DEFAULT="${FLEET_NOTIFY_SEAT:-${AGENT_SEAT:-ST}}"

log() { printf '[fleet-notify] %s\n' "$*" >&2; }

resolve_agent_sync() {
  if command -v agent-sync >/dev/null 2>&1; then
    printf '%s\n' agent-sync
    return 0
  fi
  local cache="${FLEET_COORD_CACHE:-$HOME/.cache/ai-fleet-coordinator}/scripts/agent-sync"
  if [ -x "$cache" ]; then
    printf '%s\n' "$cache"
    return 0
  fi
  return 1
}

has_credentials() {
  if [ -n "${ZULIP_RC:-}" ] && [ -r "${ZULIP_RC}" ]; then
    return 0
  fi
  if [ -n "${ZULIP_EMAIL:-}" ] && [ -n "${ZULIP_API_KEY:-}" ] && [ -n "${ZULIP_SITE:-}" ]; then
    return 0
  fi
  local secrets_dir="${AGENT_SYNC_SECRETS_DIR:-$HOME/.secrets/Zulip}"
  if [ -r "${secrets_dir}/${SEAT_DEFAULT}-zuliprc" ]; then
    return 0
  fi
  return 1
}

usage() {
  sed -n '2,20p' "$0"
}

cmd_test() {
  local async
  async="$(resolve_agent_sync)" || { log "agent-sync not installed"; return 1; }
  if ! has_credentials; then
    log "Zulip credentials not configured (no-op path only)."
    return 2
  fi
  AGENT_SEAT="$SEAT_DEFAULT" "$async" whoami >/dev/null
  log "Zulip: OK (seat ${SEAT_DEFAULT})"
}

cmd_post() {
  local topic="" channel="$CHANNEL_DEFAULT" seat="$SEAT_DEFAULT" no_tag=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --topic)
        topic="${2:-}"
        shift 2
        ;;
      --channel)
        channel="${2:-}"
        shift 2
        ;;
      --as)
        seat="${2:-}"
        shift 2
        ;;
      --no-tag)
        no_tag=1
        shift
        ;;
      --)
        shift
        break
        ;;
      *)
        break
        ;;
    esac
  done
  local text="$*"
  if [ -z "$topic" ] || [ -z "$text" ]; then
    log "usage: $0 post --topic TOPIC [--channel C] [--as SEAT] [--no-tag] <text...>"
    return 1
  fi
  SEAT_DEFAULT="$seat"
  if [ "${FLEET_NOTIFY_DRY_RUN:-0}" = "1" ]; then
    log "dry-run: post #${channel} topic '${topic}' as ${seat}: ${text}"
    return 0
  fi
  if ! has_credentials; then
    log "Zulip credentials not configured - skipping notify (no-op)."
    return 0
  fi
  local async
  async="$(resolve_agent_sync)" || {
    log "agent-sync not installed - skipping notify."
    return 0
  }
  if [ "$no_tag" = "1" ]; then
    AGENT_SEAT="$seat" "$async" post --topic "$topic" --channel "$channel" --as "$seat" --no-tag -- "$text"
  else
    AGENT_SEAT="$seat" "$async" post --topic "$topic" --channel "$channel" --as "$seat" -- "$text"
  fi
  log "ok: posted to #${channel} topic '${topic}'"
}

CMD="${1:-help}"
[ $# -gt 0 ] && shift || true

case "$CMD" in
  ""|help|-h|--help) usage; exit 0 ;;
  test) cmd_test ;;
  post) cmd_post "$@" ;;
  *)
    log "unknown command: $CMD"
    usage
    exit 1
    ;;
esac

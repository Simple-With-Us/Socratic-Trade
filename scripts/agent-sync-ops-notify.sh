#!/usr/bin/env bash
# agent-sync-ops-notify.sh - operational notices to Zulip #alerts via agent-sync.
#
# Replaces direct Slack Web API posts from deploy-freshness, provider-knob sync,
# and other ops scripts.  Coordination chat stays on #agent-sync; automated ops
# notices use the fleet alerts format (docs/protocols/zulip-fleet-guide.md).
#
# Usage:
#   agent-sync-ops-notify.sh post MODERATE "deploy freshness STALE: ..."
#   agent-sync-ops-notify.sh post "INFO  •  Socratic-Trade  •  already formatted"
#
# Subcommands:
#   post   Send one line to #alerts (topic = service name).
#   test   Verify agent-sync credentials for the configured seat (exit 0/1).
#
# Env:
#   AGENT_SYNC_OPS_NOTIFY=1     required to send (default 0 = log and skip).
#   AGENT_SEAT                  seat bot identity (default ST).
#   ZULIP_ALERTS_CHANNEL        default alerts
#   ZULIP_ALERTS_TOPIC          default Socratic-Trade
#   AGENT_SYNC_SESSION          optional session tag (default ops)
#
# Credentials: ZULIP_RC, or ~/.secrets/Zulip/<Seat>-zuliprc, or ZULIP_EMAIL +
# ZULIP_API_KEY + ZULIP_SITE (same as agent-sync).
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NOTIFY="${AGENT_SYNC_OPS_NOTIFY:-0}"
SEAT="${AGENT_SEAT:-ST}"
CHANNEL="${ZULIP_ALERTS_CHANNEL:-alerts}"
TOPIC="${ZULIP_ALERTS_TOPIC:-Socratic-Trade}"
SESSION="${AGENT_SYNC_SESSION:-ops}"

log() { printf '[agent-sync-ops-notify] %s\n' "$*" >&2; }

have_agent_sync() {
  command -v agent-sync >/dev/null 2>&1
}

format_line() {
  local severity="$1"
  shift
  if [ "$#" -lt 1 ]; then
    log "error: missing message after severity ${severity}"
    return 2
  fi
  printf '%s  •  %s  •  %s' "$severity" "$TOPIC" "$*"
}

post_line() {
  local line="$1"
  if [ "$NOTIFY" != "1" ]; then
    log "notify skipped (AGENT_SYNC_OPS_NOTIFY=${NOTIFY})."
    return 0
  fi
  if ! have_agent_sync; then
    log "notify skipped (agent-sync not on PATH)."
    return 0
  fi
  if ! agent-sync --as "$SEAT" --session "$SESSION" post \
      --channel "$CHANNEL" --topic "$TOPIC" --no-tag "$line" >/dev/null 2>&1; then
    log "warn: agent-sync post failed (missing Zulip credentials or API error)."
    return 1
  fi
  return 0
}

cmd_post() {
  if [ "$#" -lt 1 ]; then
    log "usage: $0 post MODERATE|INFO|SEVERE MESSAGE..."
    log "       $0 post \"SEVERITY  •  service  •  message\""
    return 2
  fi
  local line
  case "$1" in
    SEVERE|MODERATE|INFO)
      line="$(format_line "$@")" || return $?
      ;;
    *)
      line="$*"
      ;;
  esac
  post_line "$line"
}

cmd_test() {
  if ! have_agent_sync; then
    log "agent-sync not on PATH"
    return 1
  fi
  if agent-sync --as "$SEAT" whoami >/dev/null 2>&1; then
    echo "Zulip agent-sync: OK (seat ${SEAT})"
    return 0
  fi
  log "Zulip agent-sync: FAILED for seat ${SEAT}"
  return 1
}

case "${1:-help}" in
  post)
    shift
    cmd_post "$@"
    ;;
  test)
    cmd_test
    ;;
  help|-h)
    sed -n '2,28p' "$0"
    ;;
  *)
    log "unknown subcommand: ${1:-}"
    log "usage: $0 {post|test|help}"
    exit 2
    ;;
esac

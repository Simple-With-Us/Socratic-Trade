#!/usr/bin/env bash
# Codex Cloud coordination helper (Zulip via agent-sync; Slack retired).
# Runtime variables (not setup-only secrets): ZULIP_RC or ZULIP_EMAIL/ZULIP_API_KEY/ZULIP_SITE, GH_TOKEN
# Optional: AGENT_SEAT (default CODEX), FLEET_NOTIFY_CHANNEL (default agent-sync)
set -u

SEAT="${AGENT_SEAT:-CODEX}"
CHANNEL="${FLEET_NOTIFY_CHANNEL:-agent-sync}"
PROJECT="${CODEX_PROJECT:-Socratic-Trade}"
READ_TOPIC="${CODEX_COORD_TOPIC:-fleet}"

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

require_async() {
  ASYNC="$(resolve_agent_sync)" || {
    echo "agent-sync not installed; run scripts/install-fleet-coordination.sh" >&2
    return 1
  }
}

case "${1:-help}" in
  test)
    require_async || exit 1
    if ! AGENT_SEAT="$SEAT" "$ASYNC" whoami >/dev/null 2>&1; then
      echo "Zulip: credentials missing or identity check failed (set ZULIP_RC or ZULIP_EMAIL/ZULIP_API_KEY/ZULIP_SITE)." >&2
      exit 2
    fi
    echo "Zulip: OK"
    if [ -n "${GH_TOKEN:-}" ]; then
      gh api user --jq .login >/dev/null 2>&1 && echo "GitHub: OK" || { echo "GitHub: FAILED" >&2; exit 1; }
    else
      echo "GitHub: GH_TOKEN is not a runtime environment variable." >&2
      exit 2
    fi
    ;;
  read)
    require_async || exit 1
    limit="${2:-20}"
    AGENT_SEAT="$SEAT" "$ASYNC" read --channel "$CHANNEL" --topic "$READ_TOPIC" --limit "$limit"
    ;;
  post)
    shift
    text="$*"
    [ -n "$text" ] || { echo "usage: $0 post MESSAGE" >&2; exit 2; }
    require_async || exit 1
    body="repo: $PROJECT | [$SEAT->FLEET] $text"
    AGENT_SEAT="$SEAT" "$ASYNC" post --channel "$CHANNEL" --topic "$READ_TOPIC" --no-tag -- "$body"
    echo "Zulip post: OK"
    ;;
  github)
    gh api user --jq .login
    ;;
  help|*)
    echo "usage: $0 {test|read [N]|post MESSAGE|github}"
    ;;
esac

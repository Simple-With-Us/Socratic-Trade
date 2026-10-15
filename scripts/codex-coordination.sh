#!/usr/bin/env bash
# Codex Cloud coordination helper (Zulip via agent-sync).
# Runtime variables (not setup-only secrets): ZULIP_EMAIL, ZULIP_API_KEY, ZULIP_SITE
#   or ZULIP_RC, plus GH_TOKEN for GitHub checks.
# Optional: AGENT_SEAT, AGENT_SYNC_CHANNEL, AGENT_SYNC_TOPIC, AGENT_SYNC_REPO
set -u

AGENT="${AGENT_SEAT:-${AGENT_NAME:-CODEX}}"
CHANNEL="${AGENT_SYNC_CHANNEL:-agent-sync}"
TOPIC="${AGENT_SYNC_TOPIC:-fleet}"
REPO="${AGENT_SYNC_REPO:-Socratic-Trade}"

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

case "${1:-help}" in
  test)
    cli="$(resolve_agent_sync)" || { echo "agent-sync: MISSING" >&2; exit 1; }
    AGENT_SEAT="$AGENT" "$cli" --as "$AGENT" whoami >/dev/null \
      && echo "Zulip: OK" || { echo "Zulip: FAILED" >&2; exit 1; }
    if [ -n "${GH_TOKEN:-}" ]; then
      gh api user --jq .login >/dev/null 2>&1 && echo "GitHub: OK" \
        || { echo "GitHub: FAILED" >&2; exit 1; }
    else
      echo "GitHub: GH_TOKEN is not a runtime environment variable." >&2
      exit 2
    fi
    ;;
  read)
    limit="${3:-20}"
    topic="${2:-$TOPIC}"
    cli="$(resolve_agent_sync)" || { echo "agent-sync: MISSING" >&2; exit 1; }
    AGENT_SEAT="$AGENT" "$cli" --as "$AGENT" read --channel "$CHANNEL" --topic "$topic" --limit "$limit"
    ;;
  post)
    shift
    text="$*"
    [ -n "$text" ] || { echo "usage: $0 post MESSAGE" >&2; exit 2; }
    cli="$(resolve_agent_sync)" || { echo "agent-sync: MISSING" >&2; exit 1; }
    prefix="repo: ${REPO}  |  [${AGENT}->FLEET]"
    AGENT_SEAT="$AGENT" "$cli" --as "$AGENT" post --channel "$CHANNEL" --topic "$TOPIC" "${prefix} ${text}"
    echo "Zulip post: OK"
    ;;
  github)
    gh api user --jq .login
    ;;
  help|*)
    echo "usage: $0 {test|read [topic] [N]|post MESSAGE|github}"
    ;;
esac

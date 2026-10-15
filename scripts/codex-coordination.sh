#!/usr/bin/env bash
# Codex Cloud coordination helper (Zulip via agent-sync).
# Runtime variables (not setup-only secrets): ZULIP_EMAIL, ZULIP_API_KEY, ZULIP_SITE
# (or ZULIP_RC / ~/.secrets/Zulip/<Seat>-zuliprc), GH_TOKEN
# Optional: AGENT_SEAT, AGENT_SYNC_CHANNEL, AGENT_SYNC_TOPIC, AGENT_SYNC_PROJECT
set -u

CHANNEL="${AGENT_SYNC_CHANNEL:-agent-sync}"
TOPIC="${AGENT_SYNC_TOPIC:-codex-coordination}"
SEAT="${AGENT_SEAT:-CODEX}"
PROJECT="${AGENT_SYNC_PROJECT:-Socratic-Trade}"
AGENT="${AGENT_SYNC_AGENT_NAME:-${AGENT_NAME:-CODEX}}"

have_sync() {
  command -v agent-sync >/dev/null 2>&1
}

case "${1:-help}" in
  test)
    if ! have_sync; then
      echo "Zulip unavailable: agent-sync not on PATH." >&2
      exit 1
    fi
    if agent-sync --as "$SEAT" whoami >/dev/null 2>&1; then
      echo "Zulip: OK"
    else
      echo "Zulip: FAILED" >&2
      exit 1
    fi
    if [ -n "${GH_TOKEN:-}" ]; then
      gh api user --jq .login >/dev/null 2>&1 && echo "GitHub: OK" || { echo "GitHub: FAILED" >&2; exit 1; }
    else
      echo "GitHub: GH_TOKEN is not a runtime environment variable." >&2
      exit 2
    fi
    ;;
  read)
    limit="${2:-20}"
    if ! have_sync; then
      echo "Zulip unavailable: agent-sync not on PATH." >&2
      exit 2
    fi
    agent-sync --as "$SEAT" read --channel "$CHANNEL" --topic "$TOPIC" --limit "$limit"
    ;;
  post)
    shift
    text="$*"
    [ -n "$text" ] || { echo "usage: $0 post MESSAGE" >&2; exit 2; }
    if ! have_sync; then
      echo "Zulip unavailable: agent-sync not on PATH." >&2
      exit 2
    fi
    prefix="repo: ${PROJECT} | [${AGENT}->FLEET]"
    if agent-sync --as "$SEAT" post --channel "$CHANNEL" --topic "$TOPIC" "${prefix} ${text}" >/dev/null; then
      echo "Zulip post: OK"
    else
      echo "Zulip post: FAILED" >&2
      exit 1
    fi
    ;;
  github)
    gh api user --jq .login
    ;;
  help|*)
    echo "usage: $0 {test|read [N]|post MESSAGE|github}"
    ;;
esac

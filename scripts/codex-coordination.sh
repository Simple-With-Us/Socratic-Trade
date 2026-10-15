#!/usr/bin/env bash
# Codex Cloud coordination helper.
# Runtime variables (not setup-only secrets): SLACK_BOT_TOKEN, GH_TOKEN
# Optional: SLACK_CHANNEL_ID, SLACK_PROJECT, SLACK_AGENT_NAME, AGENT_SYNC_TOKEN
set -u

CHANNEL_ID="${SLACK_CHANNEL_ID:-C0BEZDJDNKV}"
PROJECT="${SLACK_PROJECT:-${SLACK_TOPIC:-}}"
AGENT="${SLACK_AGENT_NAME:-${AGENT_NAME:-CODEX}}"
SELF="${PROJECT:-repo}"
AUTH_CONFIG=""

cleanup() {
  [ -n "${AUTH_CONFIG:-}" ] && rm -f "$AUTH_CONFIG" 2>/dev/null
}
trap cleanup EXIT INT TERM

slack_call() {
  if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
    echo "Slack unavailable: SLACK_BOT_TOKEN is not a runtime environment variable." >&2
    return 2
  fi
  AUTH_CONFIG="$(mktemp "${TMPDIR:-/tmp}/codex-slack-auth.XXXXXX")"
  chmod 600 "$AUTH_CONFIG"
  printf 'header = "Authorization: Bearer %s"\n' "$SLACK_BOT_TOKEN" >"$AUTH_CONFIG"
  endpoint="$1"
  shift
  curl -fsS --config "$AUTH_CONFIG" "$@" "https://slack.com/api/$endpoint"
}

case "${1:-help}" in
  test)
    slack_call auth.test >/dev/null && echo "Slack: OK" || { echo "Slack: FAILED" >&2; exit 1; }
    if [ -n "${GH_TOKEN:-}" ]; then
      gh api user --jq .login >/dev/null 2>&1 && echo "GitHub: OK" || { echo "GitHub: FAILED" >&2; exit 1; }
    else
      echo "GitHub: GH_TOKEN is not a runtime environment variable." >&2
      exit 2
    fi
    ;;
  read)
    limit="${2:-20}"
    slack_call "conversations.history?channel=${CHANNEL_ID}&limit=${limit}"
    ;;
  post)
    shift
    text="$*"
    [ -n "$text" ] || { echo "usage: $0 post MESSAGE" >&2; exit 2; }
    prefix="repo: $SELF | [$AGENT->FLEET]"
    [ -n "${PROJECT:-}" ] && prefix="repo: $PROJECT | [$AGENT->FLEET]"
    payload="$(python3 - "$CHANNEL_ID" "$prefix $text" <<'PY'
import json, sys
print(json.dumps({"channel": sys.argv[1], "text": sys.argv[2]}))
PY
)"
    slack_call chat.postMessage --data "$payload" >/dev/null
    echo "Slack post: OK"
    ;;
  github)
    gh api user --jq .login
    ;;
  help|*)
    echo "usage: $0 {test|read [N]|post MESSAGE|github}"
    ;;
esac

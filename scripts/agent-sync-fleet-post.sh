#!/usr/bin/env bash
# Post one fleet coordination line to Zulip #agent-sync.  Silent no-op when agent-sync or
# Zulip credentials are unavailable (launchd-safe, CI-safe).
#
# Usage:
#   scripts/agent-sync-fleet-post.sh "deploy freshness recovered: ..."
#
# Env: AGENT_SYNC_REPO (default Socratic-Trade), AGENT_SYNC_SEAT (default CURSOR),
#      AGENT_SYNC_TOPIC (default fleet), AGENT_SYNC_CHANNEL (default agent-sync),
#      AGENT_SYNC_BIN (optional path to agent-sync).
set -u

REPO_NAME="${AGENT_SYNC_REPO:-Socratic-Trade}"
SEAT="${AGENT_SYNC_SEAT:-CURSOR}"
TOPIC="${AGENT_SYNC_TOPIC:-fleet}"
CHANNEL="${AGENT_SYNC_CHANNEL:-agent-sync}"
MSG="$*"

if [ -z "${MSG// }" ]; then
  echo "[agent-sync-fleet-post] skipped: empty message" >&2
  exit 0
fi

resolve_bin() {
  if [ -n "${AGENT_SYNC_BIN:-}" ] && [ -x "${AGENT_SYNC_BIN}" ]; then
    printf '%s\n' "${AGENT_SYNC_BIN}"
    return 0
  fi
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

BIN="$(resolve_bin)" || {
  echo "[agent-sync-fleet-post] agent-sync not installed; skipped" >&2
  exit 0
}

PREFixed="repo: ${REPO_NAME} | [${SEAT}->FLEET] ${MSG}"
# agent-sync post documents --channel (default agent-sync) and --no-tag; omit default channel.
post_args=(post --topic "$TOPIC" --as "$SEAT" --no-tag)
if [ "$CHANNEL" != "agent-sync" ]; then
  post_args+=(--channel "$CHANNEL")
fi
err_file="$(mktemp "${TMPDIR:-/tmp}/agent-sync-fleet-post.XXXXXX")" || err_file="/tmp/agent-sync-fleet-post.err"
if ! "$BIN" "${post_args[@]}" "$PREFixed" 2>"$err_file"; then
  if [ -s "$err_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      printf '[agent-sync-fleet-post] %s\n' "$line" >&2
    done <"$err_file"
  fi
  rm -f "$err_file"
  echo "[agent-sync-fleet-post] post failed (Zulip credentials missing or rejected)" >&2
  exit 0
fi
rm -f "$err_file"

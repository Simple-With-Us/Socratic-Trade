#!/usr/bin/env bash
# Post one fleet coordination line to Zulip #Work-In-Progress via simple-chat.  Silent
# no-op when simple-chat or Zulip credentials are unavailable (launchd-safe, CI-safe).
#
# Usage:
#   scripts/simple-tools-fleet-post.sh "deploy freshness recovered: ..."
#
# Env: FLEET_POST_REPO (default Socratic-Trade), FLEET_POST_SEAT (default CURSOR),
#      FLEET_POST_TOPIC (default fleet), FLEET_POST_CHANNEL (default work-in-progress),
#      FLEET_POST_BIN (optional path to simple-chat).
set -u

REPO_NAME="${FLEET_POST_REPO:-Socratic-Trade}"
SEAT="${FLEET_POST_SEAT:-CURSOR}"
TOPIC="${FLEET_POST_TOPIC:-fleet}"
CHANNEL="${FLEET_POST_CHANNEL:-work-in-progress}"
MSG="$*"

if [ -z "${MSG// }" ]; then
  echo "[simple-tools-fleet-post] skipped: empty message" >&2
  exit 0
fi

resolve_bin() {
  if [ -n "${FLEET_POST_BIN:-}" ] && [ -x "${FLEET_POST_BIN}" ]; then
    printf '%s\n' "${FLEET_POST_BIN}"
    return 0
  fi
  if command -v simple-chat >/dev/null 2>&1; then
    command -v simple-chat
    return 0
  fi
  if [ -x "${HOME}/.local/bin/simple-chat" ]; then
    printf '%s\n' "${HOME}/.local/bin/simple-chat"
    return 0
  fi
  return 1
}

BIN="$(resolve_bin)" || {
  echo "[simple-tools-fleet-post] simple-chat not installed; skipped" >&2
  exit 0
}

PREFIXED="repo: ${REPO_NAME} | [${SEAT}->FLEET] ${MSG}"
# simple-chat post documents --channel (default work-in-progress) and --no-tag; omit default channel.
post_args=(post --topic "$TOPIC" --as "$SEAT" --no-tag)
if [ "$CHANNEL" != "work-in-progress" ]; then
  post_args+=(--channel "$CHANNEL")
fi
err_file="$(mktemp "${TMPDIR:-/tmp}/simple-tools-fleet-post.XXXXXX")" || err_file="/tmp/simple-tools-fleet-post.err"
if ! "$BIN" "${post_args[@]}" "$PREFIXED" 2>"$err_file"; then
  if [ -s "$err_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      printf '[simple-tools-fleet-post] %s\n' "$line" >&2
    done <"$err_file"
  fi
  rm -f "$err_file"
  echo "[simple-tools-fleet-post] post failed (Zulip credentials missing or rejected)" >&2
  exit 0
fi
rm -f "$err_file"

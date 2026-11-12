#!/usr/bin/env bash
# Post one fleet coordination line to Zulip #ag***-s**c.  Silent no-op when ag***-s**c or
# Zulip credentials are unavailable (launchd-safe, CI-safe).
#
# Usage:
#   scripts/ag***-s**c-fleet-post.sh "deploy freshness recovered: ..."
#
# Env: AG***_S**C_REPO (default Socratic-Trade), AG***_S**C_SEAT (default CURSOR),
#      AG***_S**C_TOPIC (default fleet), AG***_S**C_CHANNEL (default ag***-s**c),
#      AG***_S**C_BIN (optional path to ag***-s**c).
set -u

REPO_NAME="${AG***_S**C_REPO:-Socratic-Trade}"
SEAT="${AG***_S**C_SEAT:-CURSOR}"
TOPIC="${AG***_S**C_TOPIC:-fleet}"
CHANNEL="${AG***_S**C_CHANNEL:-ag***-s**c}"
MSG="$*"

if [ -z "${MSG// }" ]; then
  echo "[ag***-s**c-fleet-post] skipped: empty message" >&2
  exit 0
fi

resolve_bin() {
  if [ -n "${AG***_S**C_BIN:-}" ] && [ -x "${AG***_S**C_BIN}" ]; then
    printf '%s\n' "${AG***_S**C_BIN}"
    return 0
  fi
  if command -v ag***-s**c >/dev/null 2>&1; then
    command -v ag***-s**c
    return 0
  fi
  if [ -x "${HOME}/.local/bin/ag***-s**c" ]; then
    printf '%s\n' "${HOME}/.local/bin/ag***-s**c"
    return 0
  fi
  return 1
}

BIN="$(resolve_bin)" || {
  echo "[ag***-s**c-fleet-post] ag***-s**c not installed; skipped" >&2
  exit 0
}

PREFixed="repo: ${REPO_NAME} | [${SEAT}->FLEET] ${MSG}"
# ag***-s**c post documents --channel (default ag***-s**c) and --no-tag; omit default channel.
post_args=(post --topic "$TOPIC" --as "$SEAT" --no-tag)
if [ "$CHANNEL" != "ag***-s**c" ]; then
  post_args+=(--channel "$CHANNEL")
fi
err_file="$(mktemp "${TMPDIR:-/tmp}/ag***-s**c-fleet-post.XXXXXX")" || err_file="/tmp/ag***-s**c-fleet-post.err"
if ! "$BIN" "${post_args[@]}" "$PREFixed" 2>"$err_file"; then
  if [ -s "$err_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      printf '[ag***-s**c-fleet-post] %s\n' "$line" >&2
    done <"$err_file"
  fi
  rm -f "$err_file"
  echo "[ag***-s**c-fleet-post] post failed (Zulip credentials missing or rejected)" >&2
  exit 0
fi
rm -f "$err_file"

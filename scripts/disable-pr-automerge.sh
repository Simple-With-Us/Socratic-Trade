#!/usr/bin/env bash
# Disable an already-armed pull-request auto-merge.
#
# GH_TOKEN is tried first.  A rejected credential (401/403) retries once with
# DISABLE_AUTOMERGE_FALLBACK_TOKEN, which the workflow sets to the Actions
# GITHUB_TOKEN.  Arming must not use that token.  Disabling may.
# Already-off is success.  An auth failure after the retry is a hard error so
# a still-armed merge is not reported as disarmed.
set -euo pipefail

PR_URL="${1:-}"
if [ -z "$PR_URL" ]; then
  echo "Usage: disable-pr-automerge.sh <pr-url>" >&2
  exit 2
fi

is_auth_failure() {
  printf '%s\n' "$1" | grep -qiE '401|403|Bad credentials|Unauthorized|Resource not accessible'
}

run_disable() {
  local token="$1"
  GH_TOKEN="$token" gh pr merge --disable-auto "$PR_URL" 2>&1
}

primary="${GH_TOKEN:-}"
fallback="${DISABLE_AUTOMERGE_FALLBACK_TOKEN:-}"
if [ -z "$primary" ] && [ -n "$fallback" ]; then
  primary="$fallback"
  fallback=""
fi
if [ -z "$primary" ]; then
  echo "::error::no token available to disable auto-merge for $PR_URL"
  exit 1
fi

status=0
out="$(run_disable "$primary")" || status=$?
printf '%s\n' "$out"
if [ "$status" -eq 0 ]; then
  exit 0
fi

if is_auth_failure "$out" && [ -n "$fallback" ] && [ "$fallback" != "$primary" ]; then
  echo "Primary token rejected; retrying disable with the Actions token"
  status=0
  out="$(run_disable "$fallback")" || status=$?
  printf '%s\n' "$out"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
fi

if is_auth_failure "$out"; then
  echo "::error::could not disable auto-merge for $PR_URL (credentials rejected)"
  exit 1
fi

echo "disable-auto returned nonzero (already off or not armed); continuing"
exit 0

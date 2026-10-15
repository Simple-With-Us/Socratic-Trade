#!/usr/bin/env bash
# Disable an already-armed pull-request auto-merge.
#
# GH_TOKEN is tried first.  A rejected credential (401/403) retries once with
# DISABLE_AUTOMERGE_FALLBACK_TOKEN, which the workflow sets to the Actions
# GITHUB_TOKEN.  Arming must not use that token.  Disabling may.
# Already-off is success.  The Actions token can read autoMergeRequest when it
# cannot call disablePullRequestAutoMerge ("Resource not accessible by
# integration").  A null autoMergeRequest after that refusal is success.  A
# still-armed merge is a hard error.
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

view_auto_merge() {
  local token="$1"
  local status=0
  local view
  view="$(GH_TOKEN="$token" gh pr view "$PR_URL" --json autoMergeRequest 2>&1)" || status=$?
  printf '%s\n' "$view"
  if [ "$status" -ne 0 ]; then
    return 2
  fi
  if printf '%s\n' "$view" | grep -q '"autoMergeRequest"[[:space:]]*:[[:space:]]*null'; then
    return 1
  fi
  if printf '%s\n' "$view" | grep -q '"autoMergeRequest"'; then
    return 0
  fi
  return 2
}

if is_auth_failure "$out"; then
  echo "Disable was rejected; checking whether auto-merge is already off"
  checked=""
  for token in "$fallback" "$primary"; do
    if [ -z "$token" ]; then
      continue
    fi
    case ",$checked," in
      *,"$token",*) continue ;;
    esac
    checked="${checked},${token}"
    view_status=0
    view_auto_merge "$token" || view_status=$?
    if [ "$view_status" -eq 1 ]; then
      echo "auto-merge is already off for $PR_URL"
      exit 0
    fi
    if [ "$view_status" -eq 0 ]; then
      echo "::error::auto-merge is still armed for $PR_URL and disable was rejected"
      exit 1
    fi
  done
  echo "::error::could not disable auto-merge for $PR_URL (credentials rejected)"
  exit 1
fi

echo "disable-auto returned nonzero (already off or not armed); continuing"
exit 0

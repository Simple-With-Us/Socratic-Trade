#!/usr/bin/env bash
# PM2-friendly polling fallback for preview lane sync.
# GitHub Actions is the primary event-driven path; this loop is only a repair
# fallback for missed events or a down runner.

set -euo pipefail

INTERVAL_SECONDS="${TRADING_SYNC_INTERVAL_SECONDS:-60}"
STATE_FILE="${TRADING_SYNC_STATE_FILE:-/tmp/trading-preview-sync-main.sha}"
INTEGRATION_DIR="${TRADING_INTEGRATION_DIR:-$HOME/Code/Agentic Trading}"
FETCH_REPO="${GITHUB_REPOSITORY:-jaywedgeworth22/agentic-trading}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fetch_main() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    git fetch --prune "https://x-access-token:${GITHUB_TOKEN}@github.com/${FETCH_REPO}.git" \
      '+refs/heads/main:refs/remotes/origin/main'
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    git fetch --prune "https://x-access-token:${GH_TOKEN}@github.com/${FETCH_REPO}.git" \
      '+refs/heads/main:refs/remotes/origin/main'
  else
    git fetch origin --prune
  fi
}

while true; do
  if git -C "$INTEGRATION_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    cd "$INTEGRATION_DIR"
    if fetch_main >/dev/null 2>&1; then
      remote_sha="$(git rev-parse origin/main)"
      last_sha="$(cat "$STATE_FILE" 2>/dev/null || true)"
      if [[ "$remote_sha" != "$last_sha" ]]; then
        echo "[preview-watchdog] origin/main changed to ${remote_sha:0:7}; syncing"
        if "$SCRIPT_DIR/sync-preview-lanes.sh"; then
          printf '%s\n' "$remote_sha" > "$STATE_FILE"
        else
          echo "[preview-watchdog] sync failed; will retry" >&2
        fi
      fi
    else
      echo "[preview-watchdog] fetch failed; will retry" >&2
    fi
  else
    echo "[preview-watchdog] missing integration worktree: $INTEGRATION_DIR" >&2
  fi
  sleep "$INTERVAL_SECONDS"
done

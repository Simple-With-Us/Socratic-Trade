#!/usr/bin/env bash
# Sync local beta and per-agent preview lanes after origin/main advances.
#
# This script is intentionally conservative:
# - production is handled by .github/workflows/deploy.yml, not here
# - dirty or unexpected worktrees are skipped
# - integration beta only fast-forwards main
# - agent previews only merge origin/main when clean and on their expected branch
# - a lane that fails local health/root checks is rolled back to its prior HEAD

set -euo pipefail

LOCK_DIR="${TRADING_SYNC_LOCK_DIR:-/tmp/trading-preview-sync.lock}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[preview-sync] another sync is already running; exiting"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

INTEGRATION_DIR="${TRADING_INTEGRATION_DIR:-$HOME/Code/Agentic Trading}"
APPS_DIR="${TRADING_APPS_DIR:-$HOME/apps}"
HEALTH_PATH="${TRADING_SYNC_HEALTH_PATH:-/api/health}"
FETCH_REPO="${GITHUB_REPOSITORY:-jaywedgeworth22/agentic-trading}"

log() {
  printf '[preview-sync] %s\n' "$*"
}

warn() {
  printf '[preview-sync] WARN: %s\n' "$*" >&2
}

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

current_branch() {
  git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED"
}

branch_allowed() {
  local branch="$1"
  local patterns_csv="$2"
  local pattern
  IFS=',' read -r -a patterns <<< "$patterns_csv"
  for pattern in "${patterns[@]}"; do
    if [[ "$branch" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

is_dirty() {
  [[ -n "$(git status --porcelain)" ]]
}

maybe_install_deps() {
  local before="$1"
  if ! git diff --quiet "$before" HEAD -- package.json package-lock.json; then
    log "dependency files changed; running npm ci in $(pwd)"
    npm ci
  fi
}

restart_pm2() {
  local app="$1"
  if pm2 describe "$app" >/dev/null 2>&1; then
    # Strip git auth for the --update-env restart so the preview PM2 process
    # does not inherit workflow credentials from the sync job.
    env -u GITHUB_TOKEN -u GH_TOKEN -u NODE_AUTH_TOKEN pm2 restart "$app" --update-env >/dev/null
  else
    warn "PM2 app '$app' is missing; skip restart"
  fi
}

check_url() {
  local url="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 20 -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_lane() {
  local port="$1"
  check_url "http://127.0.0.1:${port}${HEALTH_PATH}" &&
    check_url "http://127.0.0.1:${port}/"
}

sync_lane() {
  local label="$1"
  local dir="$2"
  local branch_patterns="$3"
  local pm2_app="$4"
  local port="$5"
  local merge_mode="$6"

  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "$label missing git worktree at $dir; skipping"
    return 0
  fi

  log "$label: checking $dir"
  cd "$dir"
  fetch_main

  local branch
  branch="$(current_branch)"
  if ! branch_allowed "$branch" "$branch_patterns"; then
    warn "$label on '$branch', expected one of '$branch_patterns'; skipping"
    return 0
  fi

  if is_dirty; then
    warn "$label has uncommitted changes; skipping"
    return 0
  fi

  local before after
  before="$(git rev-parse HEAD)"

  if [[ "$merge_mode" == "ff-only" ]]; then
    if ! git merge --ff-only origin/main; then
      warn "$label cannot fast-forward to origin/main; skipping"
      return 0
    fi
  else
    if ! git merge --no-edit origin/main; then
      warn "$label conflicts with origin/main; aborting merge and skipping"
      git merge --abort >/dev/null 2>&1 || true
      return 0
    fi
  fi

  after="$(git rev-parse HEAD)"
  if [[ "$before" == "$after" ]]; then
    log "$label already current at ${after:0:7}"
  else
    log "$label advanced ${before:0:7} -> ${after:0:7}"
    maybe_install_deps "$before"
    restart_pm2 "$pm2_app"
  fi

  if verify_lane "$port"; then
    log "$label healthy on :$port"
    return 0
  fi

  warn "$label failed health/root checks on :$port"
  if [[ "$before" != "$after" ]]; then
    warn "$label rolling back to ${before:0:7}"
    git reset --hard "$before" >/dev/null
    restart_pm2 "$pm2_app"
  fi
  return 1
}

failures=0

sync_lane "integration beta" "$INTEGRATION_DIR" "main" "trading-main" "4001" "ff-only" || failures=$((failures + 1))
sync_lane "Claude preview" "$APPS_DIR/trading-claude" "agent/claude,agent/claude-*,claude/*" "trading-claude" "4100" "merge" || failures=$((failures + 1))
sync_lane "Codex preview" "$APPS_DIR/trading-codex" "agent/codex,agent/codex-*,codex/*" "trading-codex" "4101" "merge" || failures=$((failures + 1))
sync_lane "Antigravity preview" "$APPS_DIR/trading-antigravity" "agent/antigravity,agent/antigravity-*,antigravity/*" "trading-antigravity" "4102" "merge" || failures=$((failures + 1))

if [[ "$failures" -gt 0 ]]; then
  warn "$failures lane(s) failed verification or rollback"
  exit 1
fi

log "done"

#!/usr/bin/env bash
# st-container-restart-monitor.sh - host-side Docker restart loop detector for ST prod.
#
# App-side boot-ledger (src/lib/boot-ledger.ts) cannot see a container that never
# reaches Node.  This script runs on the fleet Hetzner host, samples the Coolify ST
# container RestartCount / state, and pages when restarts cluster in a window or
# the container disappears.
#
# Board 2ad7f8b92e864958887e72fc25572c34 (pairs with boot-ledger board a9676caf).
#
# Exit codes:
#   0  sample ok (healthy or alert already sent / suppressed)
#   1  operational error (docker/jq/state)
#   2  alert fired this run
#
# Usage (on host):
#   bash /usr/local/sbin/st-container-restart-monitor.sh
#   ST_RESTART_MONITOR_NOTIFY=0 bash ...   # sample only
#
# Env (also loaded from /etc/default/st-container-restart-monitor when installed):
#   ST_RESTART_MONITOR_COOLIFY_ID   required (no shared default; set on the host)
#   ST_RESTART_MONITOR_WINDOW_SECONDS default 900 (15m)
#   ST_RESTART_MONITOR_DELTA_THRESHOLD default 3 (RestartCount increases in window)
#   ST_RESTART_MONITOR_STATE_PATH     default /var/lib/st-container-restart-monitor/state.json
#   ST_RESTART_MONITOR_NOTIFY         default 0 (install sets 1)
#   ST_RESTART_MONITOR_ALERT_COOLDOWN_SECONDS default 3600
#   PUSHOVER_ST_API_TOKEN / PUSHOVER_APP_TOKEN (INFISICAL.md) + PUSHOVER_USER_KEY (Pushover dashboard)
#   SENTRY_FLEET_DSN optional GitHub Actions secret (not Infisical). Unset channel stays silent.
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SENTRY_HELPER="${SCRIPT_DIR}/st-container-restart-monitor-sentry.py"

COOLIFY_ID="${ST_RESTART_MONITOR_COOLIFY_ID:-}"
WINDOW_SECONDS="${ST_RESTART_MONITOR_WINDOW_SECONDS:-900}"
DELTA_THRESHOLD="${ST_RESTART_MONITOR_DELTA_THRESHOLD:-3}"
STATE_PATH="${ST_RESTART_MONITOR_STATE_PATH:-/var/lib/st-container-restart-monitor/state.json}"
NOTIFY="${ST_RESTART_MONITOR_NOTIFY:-0}"
ALERT_COOLDOWN="${ST_RESTART_MONITOR_ALERT_COOLDOWN_SECONDS:-3600}"

log() { printf '[st-restart-monitor] %s\n' "$*" >&2; }

fail_op() {
  log "error: $*"
  exit 1
}

command -v docker >/dev/null 2>&1 || fail_op "docker is required on the host."
command -v jq >/dev/null 2>&1 || fail_op "jq is required."
printf '%s' "$WINDOW_SECONDS" | grep -Eq '^[0-9]+$' || fail_op "WINDOW_SECONDS must be an integer."
printf '%s' "$DELTA_THRESHOLD" | grep -Eq '^[0-9]+$' || fail_op "DELTA_THRESHOLD must be an integer."
printf '%s' "$ALERT_COOLDOWN" | grep -Eq '^[0-9]+$' || fail_op "ALERT_COOLDOWN must be an integer."
[ -n "$COOLIFY_ID" ] || fail_op "ST_RESTART_MONITOR_COOLIFY_ID is required."

NOW_EPOCH="$(date +%s)"

mkdir -p "$(dirname "$STATE_PATH")"

load_state() {
  if [ -f "$STATE_PATH" ]; then
    jq -c . "$STATE_PATH" 2>/dev/null || echo '{}'
  else
    echo '{}'
  fi
}

save_state() {
  local json="$1"
  printf '%s\n' "$json" | jq -c . >"${STATE_PATH}.tmp"
  mv "${STATE_PATH}.tmp" "$STATE_PATH"
}

find_container_id() {
  # Coolify names containers with the application UUID substring.
  # Prefer a live container so a stopped predecessor does not hide a running replacement.
  local live
  live="$(docker ps -q --filter "name=${COOLIFY_ID}" 2>/dev/null | head -n 1 || true)"
  if [ -n "$live" ]; then
    printf '%s' "$live"
    return 0
  fi
  docker ps -aq --filter "name=${COOLIFY_ID}" 2>/dev/null | head -n 1 || true
}

inspect_field() {
  local cid="$1" format="$2"
  docker inspect -f "$format" "$cid" 2>/dev/null || true
}

uri_encode() {
  printf '%s' "$1" | jq -sRr @uri
}

notify_pushover() {
  local title="$1" message="$2"
  local token="${PUSHOVER_ST_API_TOKEN:-}"
  if [ -z "$token" ]; then
    token="${PUSHOVER_APP_TOKEN:-}"
  fi
  local user="${PUSHOVER_USER_KEY:-}"
  if [ -z "$token" ] || [ -z "$user" ]; then
    log "pushover skipped (need PUSHOVER_ST_API_TOKEN or PUSHOVER_APP_TOKEN plus PUSHOVER_USER_KEY)."
    return 3
  fi
  local body
  body="token=$(uri_encode "$token")&user=$(uri_encode "$user")&title=$(uri_encode "$title")&message=$(uri_encode "$message")&priority=1"
  # Form body on stdin so the token and user key are not in curl argv (/proc/pid/cmdline).
  if ! printf '%s' "$body" | curl -fsS --max-time 20 -X POST https://api.pushover.net/1/messages.json \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      --data-binary @- >/dev/null; then
    log "warn: pushover post failed."
    return 1
  fi
  return 0
}

notify_sentry() {
  local message="$1" reason="$2"
  if [ -z "${SENTRY_FLEET_DSN:-}" ]; then
    log "sentry skipped (SENTRY_FLEET_DSN unset)."
    return 3
  fi
  if [ ! -f "$SENTRY_HELPER" ]; then
    log "sentry skipped (missing ${SENTRY_HELPER})."
    return 3
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log "sentry skipped (python3 required)."
    return 3
  fi
  if ! SENTRY_FLEET_DSN="$SENTRY_FLEET_DSN" python3 "$SENTRY_HELPER" "$reason" "$message"; then
    log "warn: sentry post failed."
    return 1
  fi
  return 0
}

maybe_alert() {
  local reason="$1" message="$2"
  local state last_alert
  state="$(load_state)"
  last_alert="$(printf '%s' "$state" | jq -r '.lastAlertAt // 0')"
  if [ "$last_alert" -gt 0 ]; then
    local age=$((NOW_EPOCH - last_alert))
    if [ "$age" -lt "$ALERT_COOLDOWN" ]; then
      log "alert suppressed (cooldown ${age}s < ${ALERT_COOLDOWN}s, reason was ${reason})."
      return 0
    fi
  fi
  if [ "$NOTIFY" = "1" ]; then
    # 0 = delivered, 1 = failed, 3 = skipped (unset). Cooldown arms only on a real delivery.
    # Sentry is optional, so one delivered channel is enough; requiring both would re-page
    # every tick when only Pushover is configured.
    local prc=0 src=0
    notify_pushover "ST container restart (${reason})" "$message" || prc=$?
    notify_sentry "$message" "$reason" || src=$?
    if [ "$prc" -eq 0 ] || [ "$src" -eq 0 ]; then
      state="$(printf '%s' "$state" | jq -c --argjson t "$NOW_EPOCH" --arg r "$reason" \
        '.lastAlertAt = $t | .lastAlertReason = $r')"
      save_state "$state"
    else
      log "alert not delivered (pushover=${prc} sentry=${src}); cooldown not armed."
    fi
  else
    log "notify skipped (ST_RESTART_MONITOR_NOTIFY=${NOTIFY}); alert reason: ${reason}"
  fi
  return 2
}

STATE="$(load_state)"
CID="$(find_container_id)"
PREV_CID="$(printf '%s' "$STATE" | jq -r '.containerId // empty')"
PREV_STATUS="$(printf '%s' "$STATE" | jq -r '.lastStatus // empty')"
INCREASES_JSON="$(printf '%s' "$STATE" | jq -c '.increases // []')"

if [ -z "$CID" ]; then
  # containerId is cleared while the container stays missing; lastSeenId keeps the incident open
  # so missingSince is the first sample, not "now" on every later tick.
  if [ -z "$PREV_CID" ]; then
    PREV_CID="$(printf '%s' "$STATE" | jq -r '.lastSeenId // empty')"
  fi
  if [ -n "$PREV_CID" ]; then
    msg="Socratic-Trade Coolify container (${COOLIFY_ID}) is not running on the host.  Last id ${PREV_CID}.  App-side boot-ledger cannot run if the container never starts.  Check Coolify deploy logs and docker events on the fleet Hetzner host."
    NEW_STATE="$(printf '%s' "$STATE" | jq -c \
      --argjson t "$NOW_EPOCH" \
      --arg prev "$PREV_CID" \
      --argjson inc "$INCREASES_JSON" \
      '{sampledAt: $t, containerId: "", lastStatus: "missing", increases: $inc, missingSince: (.missingSince // $t), lastSeenId: $prev, lastAlertAt: (.lastAlertAt // 0), lastAlertReason: (.lastAlertReason // "")}')"
    save_state "$NEW_STATE"
    set +e
    maybe_alert "missing" "$msg"
    alertrc=$?
    set -e
    if [ "$alertrc" -eq 2 ]; then
      exit 2
    fi
    exit 0
  fi
  log "no container matched name=${COOLIFY_ID}; baseline only."
  save_state "$(jq -nc --argjson t "$NOW_EPOCH" '{sampledAt: $t, containerId: "", lastStatus: "absent", increases: []}')"
  exit 0
fi

RESTART_COUNT="$(inspect_field "$CID" '{{.RestartCount}}')"
STATUS="$(inspect_field "$CID" '{{.State.Status}}')"
STARTED_AT="$(inspect_field "$CID" '{{.State.StartedAt}}')"
EXIT_CODE="$(inspect_field "$CID" '{{.State.ExitCode}}')"
NAME="$(inspect_field "$CID" '{{.Name}}')"

[ -n "$RESTART_COUNT" ] || fail_op "docker inspect RestartCount failed for ${CID}."
printf '%s' "$RESTART_COUNT" | grep -Eq '^[0-9]+$' || fail_op "unexpected RestartCount: ${RESTART_COUNT}"

# Trim increase events outside the window.
INCREASES_JSON="$(printf '%s' "$INCREASES_JSON" | jq -c --argjson now "$NOW_EPOCH" --argjson win "$WINDOW_SECONDS" \
  '[.[] | select(($now - .at) <= $win)]')"

if [ "$CID" != "$PREV_CID" ] && [ -n "$PREV_CID" ]; then
  log "container id changed (${PREV_CID} -> ${CID}); reset restart baseline (deploy/replace)."
  INCREASES_JSON='[]'
  PREV_STATUS=''
fi

PREV_COUNT="$(printf '%s' "$STATE" | jq -r '.lastRestartCount // empty')"
if [ -n "$PREV_COUNT" ] && [ "$CID" = "$PREV_CID" ]; then
  if [ "$RESTART_COUNT" -gt "$PREV_COUNT" ]; then
    delta=$((RESTART_COUNT - PREV_COUNT))
    log "RestartCount ${PREV_COUNT} -> ${RESTART_COUNT} (delta ${delta}) on ${NAME} status=${STATUS}."
    INCREASES_JSON="$(printf '%s' "$INCREASES_JSON" | jq -c --argjson t "$NOW_EPOCH" --argjson n "$delta" \
      '. + [range($n) | {at: $t, count: 1}]')"
  fi
fi

IN_WINDOW="$(printf '%s' "$INCREASES_JSON" | jq 'length')"

NEW_STATE="$(jq -nc \
  --arg cid "$CID" \
  --argjson rc "$RESTART_COUNT" \
  --arg st "$STATUS" \
  --arg sa "$STARTED_AT" \
  --argjson ec "${EXIT_CODE:-0}" \
  --argjson t "$NOW_EPOCH" \
  --argjson inc "$INCREASES_JSON" \
  --argjson lastAlert "$(printf '%s' "$STATE" | jq '.lastAlertAt // 0')" \
  --arg lastReason "$(printf '%s' "$STATE" | jq -r '.lastAlertReason // ""')" \
  '{sampledAt: $t, containerId: $cid, lastRestartCount: $rc, lastStatus: $st, startedAt: $sa, lastExitCode: $ec, increases: $inc, lastAlertAt: $lastAlert, lastAlertReason: $lastReason, missingSince: null}')"
save_state "$NEW_STATE"

if [ "$IN_WINDOW" -ge "$DELTA_THRESHOLD" ]; then
  msg="Socratic-Trade container ${NAME} (${CID:0:12}) hit ${IN_WINDOW} Docker restarts within ${WINDOW_SECONDS}s (RestartCount=${RESTART_COUNT}, status=${STATUS}, exit=${EXIT_CODE}, started=${STARTED_AT}).  Crash loop class - app boot-ledger may not run.  Investigate docker logs and Coolify; board 2ad7f8b92e864958887e72fc25572c34."
  maybe_alert "restart_loop" "$msg"
  exit $?
fi

if [ "$STATUS" = "exited" ] || [ "$STATUS" = "dead" ]; then
  msg="Socratic-Trade container ${NAME} (${CID:0:12}) is in terminal Docker state '${STATUS}' (exit=${EXIT_CODE}, RestartCount=${RESTART_COUNT}).  Container is down and Node is not running.  board 2ad7f8b92e864958887e72fc25572c34."
  maybe_alert "down" "$msg"
  exit $?
fi

if [ "$STATUS" = "restarting" ] && [ "$PREV_STATUS" = "restarting" ]; then
  msg="Socratic-Trade container ${NAME} (${CID:0:12}) has been in Docker state restarting for consecutive samples (RestartCount=${RESTART_COUNT}).  Container may not reach Node.  board 2ad7f8b92e864958887e72fc25572c34."
  maybe_alert "restarting" "$msg"
  exit $?
fi

log "ok: ${NAME} RestartCount=${RESTART_COUNT} status=${STATUS} increases_in_window=${IN_WINDOW}/${DELTA_THRESHOLD}."
exit 0

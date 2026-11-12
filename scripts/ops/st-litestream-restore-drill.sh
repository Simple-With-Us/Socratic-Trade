#!/usr/bin/env bash
# st-litestream-restore-drill.sh - scheduled host wrapper for scripts/litestream-restore-drill.sh
#
# Runs on fleet-hetzner-nbg1 (not in the app container).  Loads B2 credentials from a
# root-only env file, preflights disk (2.2x live DB), uses an ephemeral scratch dir, times
# the drill, writes /var/lib/st-ops/litestream-restore-drill-status.json, and posts one
# Sentry event on failure (no secret material in the message).
#
# Exit codes:
#   0  drill passed
#   1  operational error (missing creds, low disk, timeout, drill script error)
#   2  drill failed verification (Sentry may have been sent)
#
# Usage (installed):
#   /usr/local/sbin/st-litestream-restore-drill.sh
#
# Env (also from /etc/default/st-litestream-restore-drill when installed):
#   ST_RESTORE_DRILL_NOTIFY            default 1
#   ST_RESTORE_DRILL_TIMEOUT_SECONDS   default 21600 (6h; sized for ~19 GB B2 restore)
#   ST_RESTORE_DRILL_STATUS_JSON         default /var/lib/st-ops/litestream-restore-drill-status.json
#   ST_RESTORE_DRILL_STATE_DIR           default /var/lib/st-ops
#   LIVE_DB / LITESTREAM_CONFIG          passed through to the drill script
#   AWS_*                                B2 credentials (required)
#   SENTRY_FLEET_DSN                     optional; unset stays silent
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${ST_LITESTREAM_RESTORE_DRILL_SCRIPT:-}" ]; then
  DRILL_SCRIPT="$ST_LITESTREAM_RESTORE_DRILL_SCRIPT"
elif [ -f "${SCRIPT_DIR}/litestream-restore-drill.sh" ]; then
  DRILL_SCRIPT="${SCRIPT_DIR}/litestream-restore-drill.sh"
else
  DRILL_SCRIPT="${SCRIPT_DIR}/../litestream-restore-drill.sh"
fi
SENTRY_HELPER="${SCRIPT_DIR}/st-container-restart-monitor-sentry.py"
if [ ! -f "$SENTRY_HELPER" ]; then
  SENTRY_HELPER="${SCRIPT_DIR}/st-litestream-restore-drill-sentry.py"
fi

DEFAULT_ENV="/etc/default/st-litestream-restore-drill"
if [ -n "${ST_RESTORE_DRILL_TEST_ENV:-}" ] && [ -f "${ST_RESTORE_DRILL_TEST_ENV}" ]; then
  # shellcheck disable=SC1090
  set -a
  source "${ST_RESTORE_DRILL_TEST_ENV}"
  set +a
elif [ -f "$DEFAULT_ENV" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$DEFAULT_ENV"
  set +a
fi

NOTIFY="${ST_RESTORE_DRILL_NOTIFY:-1}"
TIMEOUT_SECONDS="${ST_RESTORE_DRILL_TIMEOUT_SECONDS:-21600}"
STATE_DIR="${ST_RESTORE_DRILL_STATE_DIR:-/var/lib/st-ops}"
STATUS_JSON="${ST_RESTORE_DRILL_STATUS_JSON:-${STATE_DIR}/litestream-restore-drill-status.json}"
MIN_FREE_TENTHS="${ST_RESTORE_DRILL_MIN_FREE_TENTHS:-22}"
LIVE_DB="${LIVE_DB:-/app/data/app.db}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/app/litestream.coolify.yml}"

log() { printf '[st-litestream-restore-drill] %s\n' "$*" >&2; }

fail_op() {
  log "error: $*"
  exit 1
}

SCRATCH_PARENT=""
SCRATCH_DIR=""
cleanup_scratch_dir() {
  if [ -n "$SCRATCH_DIR" ] && [ -d "$SCRATCH_DIR" ]; then
    rm -rf "$SCRATCH_DIR"
    log "removed scratch dir ${SCRATCH_DIR}"
  fi
}
trap cleanup_scratch_dir EXIT

require_creds() {
  local missing=0
  for key in AWS_S3_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    if [ -z "${!key:-}" ]; then
      log "missing required env ${key}"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || fail_op "B2 credentials not configured (populate ${DEFAULT_ENV})."
}

notify_sentry() {
  local message="$1" reason="$2"
  if [ "$NOTIFY" != "1" ]; then
    log "notify skipped (ST_RESTORE_DRILL_NOTIFY=${NOTIFY})"
    return 0
  fi
  if [ -z "${SENTRY_FLEET_DSN:-}" ]; then
    log "sentry skipped (SENTRY_FLEET_DSN unset)."
    return 0
  fi
  if [ ! -f "$SENTRY_HELPER" ]; then
    log "sentry skipped (missing ${SENTRY_HELPER})."
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log "sentry skipped (python3 required)."
    return 0
  fi
  if ! SENTRY_FLEET_DSN="$SENTRY_FLEET_DSN" python3 "$SENTRY_HELPER" "$reason" "$message"; then
    log "warn: sentry post failed."
    return 1
  fi
  return 0
}

[ -f "$DRILL_SCRIPT" ] || fail_op "drill script not found: ${DRILL_SCRIPT}"
printf '%s' "$TIMEOUT_SECONDS" | grep -Eq '^[0-9]+$' || fail_op "ST_RESTORE_DRILL_TIMEOUT_SECONDS must be an integer."

require_creds
mkdir -p "$STATE_DIR"

DB_BYTES=$(stat -c %s "${LIVE_DB}" 2>/dev/null || echo 0)
SCRATCH_PARENT="${ST_RESTORE_DRILL_SCRATCH_PARENT:-/data/scratch}"
mkdir -p "$SCRATCH_PARENT"
AVAIL_BYTES=$(( $(df -Pk "${SCRATCH_PARENT}" | awk 'NR==2 {print $4}') * 1024 ))
REQUIRED_BYTES=0
if [ "$DB_BYTES" -gt 0 ]; then
  REQUIRED_BYTES=$(( (DB_BYTES * MIN_FREE_TENTHS) / 10 ))
fi
if [ "$DB_BYTES" -gt 0 ] && [ "$AVAIL_BYTES" -lt "$REQUIRED_BYTES" ]; then
  msg="Litestream restore drill refused: ${SCRATCH_PARENT} has ${AVAIL_BYTES} bytes free; need >= ${REQUIRED_BYTES} (${MIN_FREE_TENTHS}/10 x live ${DB_BYTES})."
  log "$msg"
  notify_sentry "$msg" "low_disk" || true
  fail_op "insufficient scratch disk"
fi

SCRATCH_DIR="$(mktemp -d "${SCRATCH_PARENT}/restore-drill.XXXXXX")"
log "scratch dir ${SCRATCH_DIR}; live db ${LIVE_DB} (${DB_BYTES} bytes); timeout ${TIMEOUT_SECONDS}s"

set +e
if [ "${ST_RESTORE_DRILL_USE_TIMEOUT:-1}" = "1" ] && command -v timeout >/dev/null 2>&1; then
  RESTORE_DRILL_STATUS_JSON="$STATUS_JSON" \
  RESTORE_DRILL_MIN_FREE_TENTHS="$MIN_FREE_TENTHS" \
  SCRATCH_DIR="$SCRATCH_DIR" \
  LIVE_DB="$LIVE_DB" \
  LITESTREAM_CONFIG="$LITESTREAM_CONFIG" \
    timeout --signal=TERM "${TIMEOUT_SECONDS}" bash "$DRILL_SCRIPT"
else
  RESTORE_DRILL_STATUS_JSON="$STATUS_JSON" \
  RESTORE_DRILL_MIN_FREE_TENTHS="$MIN_FREE_TENTHS" \
  SCRATCH_DIR="$SCRATCH_DIR" \
  LIVE_DB="$LIVE_DB" \
  LITESTREAM_CONFIG="$LITESTREAM_CONFIG" \
    bash "$DRILL_SCRIPT"
fi
rc=$?
set -e

if [ "$rc" -eq 124 ]; then
  msg="Litestream restore drill timed out after ${TIMEOUT_SECONDS}s (scratch ${SCRATCH_DIR})."
  log "$msg"
  notify_sentry "$msg" "timeout" || true
  fail_op "drill timed out"
fi

if [ "$rc" -ne 0 ]; then
  msg="Litestream restore drill failed (exit ${rc}).  See journal and ${STATUS_JSON}."
  log "$msg"
  notify_sentry "$msg" "drill_failed" || true
  exit 2
fi

log "drill passed; status ${STATUS_JSON}"
exit 0

#!/usr/bin/env bash
# st-litestream-restore-drill.sh - scheduled host wrapper for scripts/litestream-restore-drill.sh
#
# Runs on the production restore-drill host (not in the app container).  Loads B2
# credentials from Infisical using a service token file (never machine identities
# or universal auth), preflights disk (2.2x live DB), uses an ephemeral scratch
# dir, times the drill, writes /var/lib/st-ops/litestream-restore-drill-status.json,
# and posts one Sentry event on failure (no secret material in the message).
#
# Exit codes:
#   0  drill passed and status JSON was refreshed
#   1  operational error (missing creds, low disk, timeout, status write, signal)
#   2  drill failed verification (Sentry may have been sent)
# 130  terminated by SIGINT (128+2)
# 143  terminated by SIGTERM (128+15)
#
# Usage (installed):
#   /usr/local/sbin/st-litestream-restore-drill.sh
#
# Env (also from /etc/default/st-litestream-restore-drill when installed).
# The env file holds non-secret config only.  Under systemd, EnvironmentFile
# *is* the process environment.  Credential values (AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, SENTRY_FLEET_DSN, INFISICAL_TOKEN, machine-identity
# secrets) are never taken from that file.  They are read from Infisical via
# INFISICAL_TOKEN_FILE, a mode-0600 service token.  Process-environment
# credentials are used only when ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1 (tests or
# an emergency manual run).  That gate is not for the scheduled timer.
#
#   ST_RESTORE_DRILL_NOTIFY            default 1
#   ST_RESTORE_DRILL_TIMEOUT_SECONDS   default 21600 (6h; sized for ~19 GB B2 restore)
#   ST_RESTORE_DRILL_STATUS_JSON       default /var/lib/st-ops/litestream-restore-drill-status.json
#   ST_RESTORE_DRILL_STATE_DIR         default /var/lib/st-ops
#   LIVE_DB / LITESTREAM_CONFIG        passed through to the drill script
#   AWS_S3_BUCKET_NAME / AWS_S3_ENDPOINT / AWS_REGION   non-secret B2 config (env file is OK)
#   INFISICAL_TOKEN_FILE               required for the scheduled lane (path only)
#   INFISICAL_DOMAIN                   documented default https://app.infisical.com (confirm)
#   INFISICAL_PROJECT_ID               always required; always passed as --projectId
#   INFISICAL_ENV                      documented default prod (confirm)
#   INFISICAL_SECRET_PATH              documented default / (confirm; do not assume a subpath)
#   INFISICAL_SECRET_AWS_ACCESS_KEY_ID default AWS_ACCESS_KEY_ID (confirm)
#   INFISICAL_SECRET_AWS_SECRET_ACCESS_KEY default AWS_SECRET_ACCESS_KEY (confirm)
#   INFISICAL_SECRET_SENTRY_FLEET_DSN  default SENTRY_FLEET_DSN (optional secret; confirm)
#   ST_RESTORE_DRILL_ALLOW_ENV_CREDS   default 0; 1 allows process/file creds (tests only)
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
# Drill-specific helper (own logger/fingerprint); it reuses the container monitor's DSN parser.
# Tests may override the path; never pass a secret on argv.
SENTRY_HELPER="${ST_RESTORE_DRILL_SENTRY_HELPER:-${SCRIPT_DIR}/st-litestream-restore-drill-sentry.py}"

DEFAULT_ENV="/etc/default/st-litestream-restore-drill"

# Defaults first so a failure before the env file is parsed still has a status path.
# Process-environment values (including test overrides) already win here.
NOTIFY="${ST_RESTORE_DRILL_NOTIFY:-1}"
TIMEOUT_SECONDS="${ST_RESTORE_DRILL_TIMEOUT_SECONDS:-21600}"
STATE_DIR="${ST_RESTORE_DRILL_STATE_DIR:-/var/lib/st-ops}"
STATUS_JSON="${ST_RESTORE_DRILL_STATUS_JSON:-${STATE_DIR}/litestream-restore-drill-status.json}"
MIN_FREE_TENTHS="${ST_RESTORE_DRILL_MIN_FREE_TENTHS:-22}"
LIVE_DB="${LIVE_DB:-/app/data/app.db}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/app/litestream.coolify.yml}"
LOAD_ENV_MALFORMED=0
# Run id before the env file is parsed so every status write, including early
# config failures, carries it.
if [ -z "${RESTORE_DRILL_RUN_ID:-}" ]; then
  RESTORE_DRILL_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
export RESTORE_DRILL_RUN_ID

log() { printf '[st-litestream-restore-drill] %s\n' "$*" >&2; }

# Record an operational failure so a previous run's pass:true never survives a failed run.
write_failure_status() {
  local reason="$1"
  [ -n "${STATUS_JSON:-}" ] || return 0
  mkdir -p "$(dirname "$STATUS_JSON")" 2>/dev/null || {
    log "status JSON not written: ${STATUS_JSON} (cannot create parent directory)"
    return 1
  }
  local safe_reason run_json
  safe_reason="$(printf '%s' "$reason" | tr -d '"\\' | tr -c '[:print:]' ' ')"
  run_json=""
  if [ -n "${RESTORE_DRILL_RUN_ID:-}" ]; then
    run_json="$(printf ',"runId":"%s"' "$(printf '%s' "$RESTORE_DRILL_RUN_ID" | tr -d '"\\')")"
  fi
  if {
    printf '{"timestamp":"%s","durationSeconds":0,"restoredSizeBytes":0,"integrity":"","rowCountDeltas":{},"pass":false,"error":"%s"%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$safe_reason" "$run_json"
  } >"${STATUS_JSON}.tmp" 2>/dev/null && mv "${STATUS_JSON}.tmp" "$STATUS_JSON" 2>/dev/null; then
    return 0
  fi
  log "status JSON not written: ${STATUS_JSON}"
  return 1
}

fail_op() {
  log "error: $*"
  write_failure_status "$*" || true
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

# systemd stops the unit with SIGTERM; write pass:false, alert, then exit 128+N.
# EXIT still removes scratch.  The trap is installed before env loading so a
# parse failure cannot abort without failure handling.  The drill is waited on
# in the background so this trap runs immediately instead of after the child
# finishes.  systemd KillMode=control-group also signals the child; we still
# TERM it here for manual stops and tests that signal only the wrapper.
DRILL_PID=""
on_term() {
  local sig="${1:-TERM}"
  local rc=143
  case "$sig" in
    INT) rc=130 ;;
    TERM) rc=143 ;;
  esac
  trap - TERM INT
  if [ -n "${DRILL_PID:-}" ]; then
    kill -TERM "$DRILL_PID" 2>/dev/null || true
    wait "$DRILL_PID" 2>/dev/null || true
    DRILL_PID=""
  fi
  log "terminated by signal ${sig}"
  notify_sentry "Litestream restore drill terminated by signal." "terminated" || true
  write_failure_status "terminated by signal" || true
  exit "$rc"
}

trap cleanup_scratch_dir EXIT
trap 'on_term TERM' TERM
trap 'on_term INT' INT

is_valid_ident() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

# Secrets that must not be taken from the env file in the scheduled lane.
is_file_forbidden_secret() {
  case "$1" in
    AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SENTRY_FLEET_DSN|INFISICAL_TOKEN|INFISICAL_CLIENT_ID|INFISICAL_CLIENT_SECRET|INFISICAL_ST_CLIENT_ID|INFISICAL_ST_CLIENT_SECRET)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_b2_or_sentry_secret() {
  case "$1" in
    AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SENTRY_FLEET_DSN) return 0 ;;
    *) return 1 ;;
  esac
}

# Assign only keys not already in the environment (env-first for non-secrets).
# Invalid keys are skipped and reported (never expanded).  Secret values are
# never logged.  The file accepts bare KEY=VALUE lines only.
load_env_file_respecting_env_first() {
  local file="$1"
  local line key val lineno=0
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    [ -n "$line" ] || continue
    case "$line" in
      *=*)
        key="${line%%=*}"
        key="${key%"${key##*[![:space:]]}"}"
        val="${line#*=}"
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        if ! is_valid_ident "$key"; then
          log "malformed env line ${lineno}: not a bare KEY=VALUE identifier (file accepts KEY=VALUE only)."
          LOAD_ENV_MALFORMED=1
          continue
        fi
        if is_file_forbidden_secret "$key"; then
          if is_b2_or_sentry_secret "$key" && [ "${ST_RESTORE_DRILL_ALLOW_ENV_CREDS:-0}" = "1" ]; then
            if [ -z "${!key:-}" ]; then
              export "$key=$val"
            fi
          else
            # Neutralize systemd EnvironmentFile injection of leftover secrets.
            unset "$key" || true
            log "ignoring secret ${key} from env file; scheduled lane reads secrets from Infisical."
          fi
          continue
        fi
        if [ -n "$key" ] && [ -z "${!key:-}" ]; then
          export "$key=$val"
        fi
        ;;
      *)
        log "malformed env line ${lineno}: not a bare KEY=VALUE assignment."
        LOAD_ENV_MALFORMED=1
        ;;
    esac
  done <"$file"
}

# --- Failure handling is in place.  Now load config, then secrets. ---

if [ -n "${ST_RESTORE_DRILL_TEST_ENV:-}" ] && [ -f "${ST_RESTORE_DRILL_TEST_ENV}" ]; then
  load_env_file_respecting_env_first "${ST_RESTORE_DRILL_TEST_ENV}"
elif [ -f "$DEFAULT_ENV" ]; then
  load_env_file_respecting_env_first "$DEFAULT_ENV"
fi

# Credentials inherited from the process environment (a leftover systemd
# Environment= line, systemctl set-environment, an operator shell) must not
# bypass Infisical.  Drop them unless the explicit test/manual gate is set.
if [ "${ST_RESTORE_DRILL_ALLOW_ENV_CREDS:-0}" != "1" ]; then
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY SENTRY_FLEET_DSN
fi

# Refresh non-secret config that the file (or process env) may have set.
NOTIFY="${ST_RESTORE_DRILL_NOTIFY:-$NOTIFY}"
TIMEOUT_SECONDS="${ST_RESTORE_DRILL_TIMEOUT_SECONDS:-$TIMEOUT_SECONDS}"
STATE_DIR="${ST_RESTORE_DRILL_STATE_DIR:-$STATE_DIR}"
STATUS_JSON="${ST_RESTORE_DRILL_STATUS_JSON:-${STATE_DIR}/litestream-restore-drill-status.json}"
MIN_FREE_TENTHS="${ST_RESTORE_DRILL_MIN_FREE_TENTHS:-$MIN_FREE_TENTHS}"
LIVE_DB="${LIVE_DB:-$LIVE_DB}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-$LITESTREAM_CONFIG}"

# Documented defaults; every project, path, and secret name must be confirmed
# on the host.  No project id is implied here.
INFISICAL_TOKEN_FILE="${INFISICAL_TOKEN_FILE:-}"
INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-https://app.infisical.com}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"
INFISICAL_SECRET_PATH="${INFISICAL_SECRET_PATH:-/}"
INFISICAL_SECRET_AWS_ACCESS_KEY_ID="${INFISICAL_SECRET_AWS_ACCESS_KEY_ID:-AWS_ACCESS_KEY_ID}"
INFISICAL_SECRET_AWS_SECRET_ACCESS_KEY="${INFISICAL_SECRET_AWS_SECRET_ACCESS_KEY:-AWS_SECRET_ACCESS_KEY}"
INFISICAL_SECRET_SENTRY_FLEET_DSN="${INFISICAL_SECRET_SENTRY_FLEET_DSN:-SENTRY_FLEET_DSN}"

# Read a secret's value to stdout.  Never print it to stderr or logs.
# Prefer the Infisical CLI; fall back to the HTTP API.  Service token only.
infisical_get_plain() {
  local secret_name="$1"
  local token_file="$INFISICAL_TOKEN_FILE"
  local err out rc=1
  [ -n "$secret_name" ] || return 1
  [ -n "$token_file" ] && [ -f "$token_file" ] || return 1
  # Always name the project; never let the CLI pick a workspace on its own.
  [ -n "${INFISICAL_PROJECT_ID:-}" ] || return 1

  if command -v infisical >/dev/null 2>&1; then
    err="$(mktemp "${TMPDIR:-/tmp}/st-restore-drill-infisical.XXXXXX")" || return 1
    set +x
    rc=0
    out="$(
      INFISICAL_TOKEN="$(tr -d '\n' <"$token_file")"
      export INFISICAL_TOKEN
      infisical secrets get "$secret_name" --plain \
        --projectId="$INFISICAL_PROJECT_ID" \
        --env="$INFISICAL_ENV" \
        --path="$INFISICAL_SECRET_PATH" \
        --domain="$INFISICAL_DOMAIN" 2>"$err"
    )" || rc=$?
    rm -f "$err"
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
      printf '%s' "$out"
      return 0
    fi
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  set +x
  ST_INFISICAL_SECRET_NAME="$secret_name" \
  ST_INFISICAL_TOKEN_FILE="$token_file" \
  ST_INFISICAL_DOMAIN="$INFISICAL_DOMAIN" \
  ST_INFISICAL_PROJECT_ID="$INFISICAL_PROJECT_ID" \
  ST_INFISICAL_ENV="$INFISICAL_ENV" \
  ST_INFISICAL_SECRET_PATH="$INFISICAL_SECRET_PATH" \
  python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

name = os.environ["ST_INFISICAL_SECRET_NAME"]
token_path = Path(os.environ["ST_INFISICAL_TOKEN_FILE"])
try:
    token = token_path.read_text().strip()
except OSError:
    sys.exit(1)
if not token:
    sys.exit(1)
domain = os.environ.get("ST_INFISICAL_DOMAIN", "https://app.infisical.com").rstrip("/")
project = os.environ.get("ST_INFISICAL_PROJECT_ID", "")
env = os.environ.get("ST_INFISICAL_ENV", "prod")
path = os.environ.get("ST_INFISICAL_SECRET_PATH") or "/"
if not project:
    print("infisical api: INFISICAL_PROJECT_ID is required", file=sys.stderr)
    sys.exit(1)
query = urllib.parse.urlencode(
    {"workspaceId": project, "environment": env, "secretPath": path}
)
url = f"{domain}/api/v3/secrets/raw/{urllib.parse.quote(name, safe='')}?{query}"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}, method="GET")
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read()
except urllib.error.HTTPError as exc:
    print(f"infisical api: HTTP {exc.code}", file=sys.stderr)
    sys.exit(1)
except Exception as exc:
    print(f"infisical api: {type(exc).__name__}", file=sys.stderr)
    sys.exit(1)
try:
    data = json.loads(body.decode())
    value = data.get("secret", {}).get("secretValue")
except Exception:
    print("infisical api: unreadable response", file=sys.stderr)
    sys.exit(1)
if not isinstance(value, str) or value == "":
    sys.exit(1)
sys.stdout.write(value)
PY
}

# True when the token file holds one Infisical service token: not a symlink,
# a readable regular file, st.* prefix, no whitespace, 20-2048 characters.
# The token is never printed.  Mode is checked separately.
token_file_shape_ok() {
  local token_file="$1" token
  [ -n "$token_file" ] || return 1
  [ ! -L "$token_file" ] || return 1
  [ -f "$token_file" ] && [ -r "$token_file" ] || return 1
  set +x
  token="$(cat <"$token_file" 2>/dev/null)" || return 1
  [[ "$token" == st.* ]] || return 1
  [[ "$token" != *[[:space:]]* ]] || return 1
  [ "${#token}" -ge 20 ] && [ "${#token}" -le 2048 ]
}

# Alert, then fail.  The DSN is fetched through Infisical only when the token
# itself passed validation (fetch=1); otherwise only an already-available DSN
# can be used, and the pass:false status from fail_op is the remaining signal.
token_file_fail() {
  local msg="$1" fetch="${2:-0}"
  if [ "$fetch" = "1" ]; then
    fetch_optional_sentry_dsn || true
  fi
  notify_sentry "Litestream restore drill: ${msg}" "token_file_invalid" || true
  fail_op "$msg"
}

require_token_file() {
  local token_file="$INFISICAL_TOKEN_FILE"
  if [ -z "$token_file" ]; then
    token_file_fail "INFISICAL_TOKEN_FILE is not set.  The scheduled drill reads B2 credentials from Infisical with a service token file (not from the env file, and not with a machine identity)."
  fi
  if [ -L "$token_file" ]; then
    token_file_fail "INFISICAL_TOKEN_FILE must not be a symbolic link."
  fi
  if [ ! -f "$token_file" ] || [ ! -r "$token_file" ]; then
    token_file_fail "INFISICAL_TOKEN_FILE is missing or unreadable (path configured in the env file)."
  fi
  if [ ! -s "$token_file" ]; then
    token_file_fail "INFISICAL_TOKEN_FILE is empty."
  fi
  if ! token_file_shape_ok "$token_file"; then
    token_file_fail "INFISICAL_TOKEN_FILE must contain one 20-2048 character Infisical service token (st.*) with no whitespace; machine-identity and personal tokens are not accepted."
  fi
  local perm
  perm="$(stat -c '%a' "$token_file" 2>/dev/null || stat -f '%OLp' "$token_file" 2>/dev/null || echo "")"
  perm="${perm#0}"
  if [ "$perm" != "600" ]; then
    # The token passed validation, so it can still fetch the DSN for the alert.
    token_file_fail "INFISICAL_TOKEN_FILE must be mode 0600." 1
  fi
}

# Best-effort DSN load so a config failure can still alert.  Never fail_op here.
fetch_optional_sentry_dsn() {
  if [ -n "${SENTRY_FLEET_DSN:-}" ]; then
    return 0
  fi
  # Only a valid service token is ever sent to Infisical.
  token_file_shape_ok "${INFISICAL_TOKEN_FILE:-}" || return 1
  [ -n "${INFISICAL_PROJECT_ID:-}" ] || return 1
  local value
  value="$(infisical_get_plain "$INFISICAL_SECRET_SENTRY_FLEET_DSN" || true)"
  if [ -n "$value" ]; then
    export SENTRY_FLEET_DSN="$value"
    return 0
  fi
  return 1
}

fetch_required_secret() {
  local dest="$1"
  local secret_name="$2"
  if [ -n "${!dest:-}" ]; then
    return 0
  fi
  local value
  if ! value="$(infisical_get_plain "$secret_name")"; then
    log "Infisical did not return ${dest} (configured secret name must be confirmed on the host)."
    return 1
  fi
  export "$dest=$value"
  return 0
}

resolve_scheduled_credentials() {
  local allow="${ST_RESTORE_DRILL_ALLOW_ENV_CREDS:-0}"
  if [ "$allow" = "1" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    fetch_optional_sentry_dsn || true
    return 0
  fi
  require_token_file
  if [ -z "${INFISICAL_PROJECT_ID:-}" ]; then
    notify_sentry "Litestream restore drill: INFISICAL_PROJECT_ID is not set." "config_invalid" || true
    fail_op "INFISICAL_PROJECT_ID is not set.  Supply the Infisical project id at install time; this wrapper does not assume one."
  fi
  local missing=0
  fetch_required_secret AWS_ACCESS_KEY_ID "$INFISICAL_SECRET_AWS_ACCESS_KEY_ID" || missing=1
  fetch_required_secret AWS_SECRET_ACCESS_KEY "$INFISICAL_SECRET_AWS_SECRET_ACCESS_KEY" || missing=1
  fetch_optional_sentry_dsn || true
  if [ "$missing" -ne 0 ]; then
    fail_op "B2 credentials were not available from Infisical.  Confirm INFISICAL_TOKEN_FILE, INFISICAL_PROJECT_ID, INFISICAL_ENV, INFISICAL_SECRET_PATH, and the secret names (defaults AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be confirmed)."
  fi
}

if [ "$LOAD_ENV_MALFORMED" -ne 0 ]; then
  fetch_optional_sentry_dsn || true
  notify_sentry "Litestream restore drill env file has a malformed line.  The file accepts bare KEY=VALUE only." "malformed_env" || true
  fail_op "malformed line in env file (bare KEY=VALUE only)"
fi

resolve_scheduled_credentials

require_creds() {
  local missing=0
  for key in AWS_S3_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    if [ -z "${!key:-}" ]; then
      log "missing required env ${key}"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || fail_op "B2 credentials not configured (set INFISICAL_TOKEN_FILE and confirm secret names, or AWS_S3_BUCKET_NAME in the env file)."
}

[ -f "$DRILL_SCRIPT" ] || fail_op "drill script not found: ${DRILL_SCRIPT}"
printf '%s' "$TIMEOUT_SECONDS" | grep -Eq '^[0-9]+$' || fail_op "ST_RESTORE_DRILL_TIMEOUT_SECONDS must be an integer."
printf '%s' "$MIN_FREE_TENTHS" | grep -Eq '^[0-9]+$' || fail_op "ST_RESTORE_DRILL_MIN_FREE_TENTHS must be an integer."

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
log "scratch dir ${SCRATCH_DIR}; live db ${LIVE_DB} (${DB_BYTES} bytes); timeout ${TIMEOUT_SECONDS}s; run ${RESTORE_DRILL_RUN_ID}"

status_refreshed() {
  [ -f "$STATUS_JSON" ] || return 1
  [ -n "${RESTORE_DRILL_RUN_ID:-}" ] || return 1
  grep -F -q "$RESTORE_DRILL_RUN_ID" "$STATUS_JSON"
}

set +e
if [ "${ST_RESTORE_DRILL_USE_TIMEOUT:-1}" = "1" ] && command -v timeout >/dev/null 2>&1; then
  RESTORE_DRILL_STATUS_JSON="$STATUS_JSON" \
  RESTORE_DRILL_MIN_FREE_TENTHS="$MIN_FREE_TENTHS" \
  RESTORE_DRILL_RUN_ID="$RESTORE_DRILL_RUN_ID" \
  SCRATCH_DIR="$SCRATCH_DIR" \
  LIVE_DB="$LIVE_DB" \
  LITESTREAM_CONFIG="$LITESTREAM_CONFIG" \
    timeout --signal=TERM "${TIMEOUT_SECONDS}" bash "$DRILL_SCRIPT" &
else
  RESTORE_DRILL_STATUS_JSON="$STATUS_JSON" \
  RESTORE_DRILL_MIN_FREE_TENTHS="$MIN_FREE_TENTHS" \
  RESTORE_DRILL_RUN_ID="$RESTORE_DRILL_RUN_ID" \
  SCRATCH_DIR="$SCRATCH_DIR" \
  LIVE_DB="$LIVE_DB" \
  LITESTREAM_CONFIG="$LITESTREAM_CONFIG" \
    bash "$DRILL_SCRIPT" &
fi
DRILL_PID=$!
wait "$DRILL_PID"
rc=$?
DRILL_PID=""
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
  # If the drill did not refresh status, write a failure record so a stale pass:true cannot remain.
  if ! status_refreshed; then
    write_failure_status "drill failed (exit ${rc}); status JSON not refreshed" || true
  fi
  exit 2
fi

if ! status_refreshed; then
  msg="Litestream restore drill status JSON was not written or not refreshed (${STATUS_JSON})."
  log "$msg"
  notify_sentry "$msg" "status_unwritten" || true
  fail_op "status JSON not written"
fi

log "drill passed; status ${STATUS_JSON}"
exit 0

#!/usr/bin/env bash
# st-litestream-restore-drill.selftest.sh - hermetic matrix (stub drill + df/stat + temp env).
#
# Usage: bash scripts/ops/st-litestream-restore-drill.selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/st-litestream-restore-drill.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/st-litestream-restore-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

STUB_DIR="${WORK}/bin"
mkdir -p "$STUB_DIR" "${WORK}/scratch" "${WORK}/ops" "${WORK}/secrets"
STATUS_JSON="${WORK}/status.json"
ENV_FILE="${WORK}/st-litestream-restore-drill.env"
LIVE_DB="${WORK}/live.app.db"
TOKEN_FILE="${WORK}/secrets/infisical.token"
SENTRY_OUT="${WORK}/sentry.out"
SENTRY_HELPER="${WORK}/st-litestream-restore-drill-sentry.py"
printf 'x' >"$LIVE_DB"
printf 'st.test-service-token\n' >"$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

export ST_RESTORE_DRILL_TEST_ENV="$ENV_FILE"
export ST_RESTORE_DRILL_NOTIFY=0
export ST_RESTORE_DRILL_USE_TIMEOUT=0
export ST_RESTORE_DRILL_SCRATCH_PARENT="${WORK}/scratch"
export ST_RESTORE_DRILL_STATE_DIR="${WORK}/state"
export ST_RESTORE_DRILL_STATUS_JSON="$STATUS_JSON"
mkdir -p "${WORK}/state"

write_env_config() {
  cat >"$ENV_FILE" <<ENVC
ST_RESTORE_DRILL_NOTIFY=${ENV_NOTIFY:-0}
ST_RESTORE_DRILL_STATE_DIR=${WORK}/state
ST_RESTORE_DRILL_STATUS_JSON=${STATUS_JSON}
AWS_S3_BUCKET_NAME=test-bucket
LIVE_DB=${LIVE_DB}
INFISICAL_TOKEN_FILE=${ENV_TOKEN_FILE:-$TOKEN_FILE}
INFISICAL_PROJECT_ID=${ENV_PROJECT_ID-test-project-id}
INFISICAL_ENV=prod
INFISICAL_SECRET_PATH=/
INFISICAL_DOMAIN=https://app.infisical.com
ENVC
}

# Default test env also plants dummy secret lines so we can prove the scheduled
# lane ignores them unless ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1.
write_env_creds() {
  write_env_config
  cat >>"$ENV_FILE" <<SECRETS
AWS_ACCESS_KEY_ID=file-key-id
AWS_SECRET_ACCESS_KEY=file-secret-SHOULD-NOT-LEAK
SENTRY_FLEET_DSN=https://file-dsn@example.test/1
SECRETS
}

cat >"${STUB_DIR}/stat" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-c" && "${2:-}" == "%s" ]]; then
  printf '%s\n' "${STUB_DB_BYTES:-1000}"
  exit 0
fi
exec /usr/bin/stat "$@"
STUB
chmod +x "${STUB_DIR}/stat"

cat >"${STUB_DIR}/df" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-Pk" ]]; then
  avail="${STUB_DF_FREE_KB:-10000000}"
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
  printf 'stubfs 20000000 10000000 %s 50%% %s\n' "$avail" "${2:-/}"
  exit 0
fi
exec /usr/bin/df "$@"
STUB
chmod +x "${STUB_DIR}/df"

# Stub Infisical CLI.  Never prints token material.  Values are test fixtures.
cat >"${STUB_DIR}/infisical" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "secrets" && "${2:-}" == "get" ]]; then
  name=""
  plain=0
  project=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --plain) plain=1; shift ;;
      --projectId=*) project="${1#--projectId=}"; shift ;;
      --projectId) project="${2:-}"; shift 2 ;;
      --env=*|--path=*|--domain=*|--token=*) shift ;;
      --env|--path|--domain|--token) shift 2 ;;
      secrets|get) shift ;;
      *)
        if [ -z "$name" ]; then name="$1"; fi
        shift
        ;;
    esac
  done
  # Record the secret name only (never the token or the value).
  if [ -n "${STUB_INFISICAL_CALLS:-}" ]; then
    printf '%s\n' "$name" >>"${STUB_INFISICAL_CALLS}"
  fi
  if [ -z "$project" ]; then
    echo "infisical stub: --projectId missing" >&2
    exit 1
  fi
  if [ -z "${INFISICAL_TOKEN:-}" ]; then
    echo "infisical stub: missing token" >&2
    exit 1
  fi
  if [ "${STUB_INFISICAL_FAIL:-0}" = "1" ]; then
    echo "infisical stub: forced failure" >&2
    exit 1
  fi
  case " ${STUB_INFISICAL_MISSING:-} " in
    *" ${name} "*) echo "infisical stub: secret not found" >&2; exit 1 ;;
  esac
  case "$name" in
    AWS_ACCESS_KEY_ID) value="${STUB_INFISICAL_ACCESS_KEY:-infisical-key-id}" ;;
    AWS_SECRET_ACCESS_KEY) value="${STUB_INFISICAL_SECRET_KEY:-infisical-secret}" ;;
    SENTRY_FLEET_DSN) value="${STUB_INFISICAL_DSN:-https://infisical-dsn@example.test/9}" ;;
    *) echo "infisical stub: unknown secret name" >&2; exit 1 ;;
  esac
  if [ "$plain" -eq 1 ]; then
    printf '%s' "$value"
    exit 0
  fi
  exit 1
fi
echo "infisical stub: unsupported argv" >&2
exit 1
STUB
chmod +x "${STUB_DIR}/infisical"

cat >"${WORK}/stub-drill.sh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [[ "${STUB_DRILL_SLEEP_SECONDS:-0}" -gt 0 ]]; then
  sleep "${STUB_DRILL_SLEEP_SECONDS}"
fi
if [[ "${STUB_DRILL_SKIP_STATUS:-0}" != "1" && -n "${RESTORE_DRILL_STATUS_JSON:-}" ]]; then
  integrity="${STUB_INTEGRITY:-ok}"
  pass="${STUB_DRILL_PASS:-true}"
  run_json=""
  if [[ -n "${RESTORE_DRILL_RUN_ID:-}" ]]; then
    run_json=$(printf ',"runId":"%s"' "$RESTORE_DRILL_RUN_ID")
  fi
  printf '{"timestamp":"2026-01-01T00:00:00Z","durationSeconds":1,"restoredSizeBytes":1000,"integrity":"%s","rowCountDeltas":{},"pass":%s%s}\n' \
    "$integrity" "$pass" "$run_json" >"${RESTORE_DRILL_STATUS_JSON}.tmp"
  mv "${RESTORE_DRILL_STATUS_JSON}.tmp" "${RESTORE_DRILL_STATUS_JSON}"
fi
if [[ -n "${STUB_CREATE_SCRATCH_FILE:-}" ]]; then
  touch "${SCRATCH_DIR}/app.db.restore-drill-stub"
fi
if [[ -n "${STUB_ASSERT_BUCKET:-}" ]]; then
  printf '%s' "${AWS_S3_BUCKET_NAME:-}" >"${STUB_ASSERT_BUCKET}"
fi
# Compare the access key in memory against a fake expected value; persist only
# a non-secret marker, never the key itself.
if [[ -n "${STUB_ASSERT_ACCESS_KEY:-}" ]]; then
  if [[ -n "${STUB_EXPECTED_ACCESS_KEY:-}" && "${AWS_ACCESS_KEY_ID:-}" == "${STUB_EXPECTED_ACCESS_KEY}" ]]; then
    printf '%s' matched >"${STUB_ASSERT_ACCESS_KEY}"
  else
    printf '%s' mismatch >"${STUB_ASSERT_ACCESS_KEY}"
    exit 1
  fi
fi
exit "${STUB_DRILL_RC:-0}"
STUB
chmod +x "${WORK}/stub-drill.sh"

cat >"$SENTRY_HELPER" <<'PY'
#!/usr/bin/env python3
import os
import sys
from pathlib import Path
out = Path(os.environ.get("STUB_SENTRY_OUT", ""))
if not out:
    sys.exit(0)
reason = sys.argv[1] if len(sys.argv) > 1 else ""
message = sys.argv[2] if len(sys.argv) > 2 else ""
# Compare the DSN in memory; record only a non-secret marker.
expected = os.environ.get("STUB_EXPECTED_DSN", "")
dsn_line = ""
if expected:
    dsn_line = "dsn=matched\n" if os.environ.get("SENTRY_FLEET_DSN", "") == expected else "dsn=mismatch\n"
out.write_text(reason + "\n" + message + "\n" + dsn_line)
sys.exit(0)
PY
chmod +x "$SENTRY_HELPER"

export PATH="${STUB_DIR}:${PATH}"

PASSES=0
FAILURES=0

run_case() {
  local name="$1" expect_rc="$2"
  shift 2
  rm -f "$STATUS_JSON" "$SENTRY_OUT"
  find "${WORK}/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r d; do rm -rf "$d"; done
  export STUB_DB_BYTES=1000 STUB_DF_FREE_KB=10000000
  export STUB_DRILL_RC=0 STUB_INTEGRITY=ok STUB_DRILL_PASS=true STUB_CREATE_SCRATCH_FILE=
  export CASE_AWS_S3_BUCKET_NAME='' CASE_AWS_ACCESS_KEY_ID='' CASE_AWS_SECRET_ACCESS_KEY=''
  export STUB_ASSERT_BUCKET='' STUB_ASSERT_ACCESS_KEY='' STUB_EXPECTED_ACCESS_KEY=''
  export STUB_EXPECTED_DSN='' STUB_INFISICAL_CALLS=''
  export STUB_DRILL_SKIP_STATUS=0 STUB_DRILL_SLEEP_SECONDS=0
  export STUB_INFISICAL_FAIL=0 STUB_INFISICAL_MISSING=
  export CASE_ALLOW_ENV_CREDS=1
  export CASE_NOTIFY=0
  export CASE_SENTRY_DSN=
  export CASE_MIN_FREE_TENTHS=22
  export LAST_OUT=""
  # Case bodies are a single quoted setup snippet that must run in this shell.
  eval "$1"
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
  LAST_OUT="$(
    env -i \
      PATH="${PATH}" \
      HOME="${HOME:-/tmp}" \
      AWS_S3_BUCKET_NAME="${CASE_AWS_S3_BUCKET_NAME:-}" \
      AWS_ACCESS_KEY_ID="${CASE_AWS_ACCESS_KEY_ID:-}" \
      AWS_SECRET_ACCESS_KEY="${CASE_AWS_SECRET_ACCESS_KEY:-}" \
      ST_RESTORE_DRILL_TEST_ENV="$ST_RESTORE_DRILL_TEST_ENV" \
      ST_RESTORE_DRILL_NOTIFY="$CASE_NOTIFY" \
      ST_RESTORE_DRILL_USE_TIMEOUT="$ST_RESTORE_DRILL_USE_TIMEOUT" \
      ST_RESTORE_DRILL_SCRATCH_PARENT="$ST_RESTORE_DRILL_SCRATCH_PARENT" \
      ST_RESTORE_DRILL_STATUS_JSON="$ST_RESTORE_DRILL_STATUS_JSON" \
      ST_RESTORE_DRILL_STATE_DIR="$ST_RESTORE_DRILL_STATE_DIR" \
      ST_RESTORE_DRILL_MIN_FREE_TENTHS="${CASE_MIN_FREE_TENTHS:-22}" \
      ST_RESTORE_DRILL_ALLOW_ENV_CREDS="${CASE_ALLOW_ENV_CREDS-0}" \
      ST_RESTORE_DRILL_SENTRY_HELPER="$SENTRY_HELPER" \
      STUB_SENTRY_OUT="$SENTRY_OUT" \
      SENTRY_FLEET_DSN="${CASE_SENTRY_DSN:-}" \
      ST_LITESTREAM_RESTORE_DRILL_SCRIPT="$ST_LITESTREAM_RESTORE_DRILL_SCRIPT" \
      STUB_DB_BYTES="$STUB_DB_BYTES" \
      STUB_DF_FREE_KB="$STUB_DF_FREE_KB" \
      STUB_DRILL_RC="${STUB_DRILL_RC:-0}" \
      STUB_INTEGRITY="${STUB_INTEGRITY:-ok}" \
      STUB_DRILL_PASS="${STUB_DRILL_PASS:-true}" \
      STUB_CREATE_SCRATCH_FILE="${STUB_CREATE_SCRATCH_FILE:-}" \
      STUB_ASSERT_BUCKET="${STUB_ASSERT_BUCKET:-}" \
      STUB_ASSERT_ACCESS_KEY="${STUB_ASSERT_ACCESS_KEY:-}" \
      STUB_EXPECTED_ACCESS_KEY="${STUB_EXPECTED_ACCESS_KEY:-}" \
      STUB_EXPECTED_DSN="${STUB_EXPECTED_DSN:-}" \
      STUB_INFISICAL_CALLS="${STUB_INFISICAL_CALLS:-}" \
      STUB_DRILL_SKIP_STATUS="${STUB_DRILL_SKIP_STATUS:-0}" \
      STUB_DRILL_SLEEP_SECONDS="${STUB_DRILL_SLEEP_SECONDS:-0}" \
      STUB_INFISICAL_FAIL="${STUB_INFISICAL_FAIL:-0}" \
      STUB_INFISICAL_MISSING="${STUB_INFISICAL_MISSING:-}" \
      STUB_INFISICAL_ACCESS_KEY="${STUB_INFISICAL_ACCESS_KEY:-infisical-key-id}" \
      STUB_INFISICAL_SECRET_KEY="${STUB_INFISICAL_SECRET_KEY:-infisical-secret}" \
      bash "$UNDER_TEST" 2>&1
  )"
  rc=$?
  local left
  left="$(find "${WORK}/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  if [ "$rc" -eq "$expect_rc" ]; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name} (rc=${rc}, scratch_dirs=${left})"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name} (expected rc=${expect_rc}, got ${rc}, scratch_dirs=${left})" >&2
    printf '%s\n' "$LAST_OUT" | sed 's/^/  | /' >&2
  fi
}

check_failure_status() {
  local name="$1"
  if [ -f "$STATUS_JSON" ] && grep -q '"pass":false' "$STATUS_JSON"; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name}_status_pass_false"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name}_status_pass_false (status json missing or not pass:false)" >&2
  fi
}

# The stub drill writes only "matched"/"mismatch", never the key.
assert_access_marker() {
  local name="$1"
  if [ -f "${WORK}/access.out" ] && [ "$(cat "${WORK}/access.out")" = "matched" ]; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name}"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name}" >&2
  fi
  rm -f "${WORK}/access.out"
}

pass_if() {
  local name="$1"
  shift
  if "$@"; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name}"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name}" >&2
  fi
}

output_leaks_secret() {
  printf '%s' "${LAST_OUT:-}" | grep -Eq 'file-secret-SHOULD-NOT-LEAK|infisical-secret|st.test-service-token'
}

write_env_creds

run_case missing_creds 1 '
  rm -f "$ENV_FILE"
  touch "$ENV_FILE"
  export CASE_ALLOW_ENV_CREDS=1
'
check_failure_status missing_creds

write_env_creds
run_case low_disk 1 '
  export STUB_DF_FREE_KB=1
  export CASE_ALLOW_ENV_CREDS=1
'
check_failure_status low_disk

write_env_creds
run_case pass 0 '
  export CASE_ALLOW_ENV_CREDS=1
'

write_env_creds
run_case integrity_fail 2 '
  export STUB_DRILL_RC=1
  export STUB_INTEGRITY=fail
  export STUB_DRILL_PASS=false
  export CASE_ALLOW_ENV_CREDS=1
'

write_env_creds
run_case cleanup_on_failure 2 '
  export STUB_DRILL_RC=1
  export STUB_CREATE_SCRATCH_FILE=1
  export CASE_ALLOW_ENV_CREDS=1
'
after_left="$(find "${WORK}/scratch" -name "app.db.restore-drill-stub" 2>/dev/null | wc -l)"
if [ "$after_left" -eq 0 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS scratch_file_removed"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL scratch_file_removed (stub files=${after_left})" >&2
fi

write_env_creds
run_case env_first_credentials 0 '
  export CASE_AWS_S3_BUCKET_NAME=env-bucket
  export CASE_AWS_ACCESS_KEY_ID=env-key
  export CASE_AWS_SECRET_ACCESS_KEY=env-secret
  export STUB_ASSERT_BUCKET="${WORK}/bucket.out"
  export STUB_ASSERT_ACCESS_KEY="${WORK}/access.out"
  export STUB_EXPECTED_ACCESS_KEY=env-key
  export CASE_ALLOW_ENV_CREDS=1
'
if [ -f "${WORK}/bucket.out" ] && [ "$(cat "${WORK}/bucket.out")" = "env-bucket" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS env_first_credentials_bucket"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL env_first_credentials_bucket" >&2
fi
# Control: the access key must be the process-env fake (env-key), not the
# file (file-key-id) or Infisical (infisical-key-id) value.
assert_access_marker env_first_credentials_access_key_from_env

write_env_creds
run_case invalid_min_free_tenths 1 '
  export CASE_MIN_FREE_TENTHS=abc
  export CASE_ALLOW_ENV_CREDS=1
'
# Control: exit 1 alone could come from an arithmetic abort.  Require this
# run's pass:false record naming the MIN_FREE_TENTHS validation.
check_failure_status invalid_min_free_tenths
pass_if invalid_min_free_tenths_names_setting grep -q 'ST_RESTORE_DRILL_MIN_FREE_TENTHS must be an integer' "$STATUS_JSON"
pass_if invalid_min_free_tenths_status_has_run_id grep -q '"runId":"' "$STATUS_JSON"

# 4: a drill that exits 0 without writing status must not be logged as a pass.
write_env_creds
run_case status_not_refreshed 1 '
  export STUB_DRILL_SKIP_STATUS=1
  export CASE_ALLOW_ENV_CREDS=1
  export CASE_NOTIFY=1
  export CASE_SENTRY_DSN=https://test-dsn@example.test/1
  export STUB_EXPECTED_DSN=https://test-dsn@example.test/1
'
check_failure_status status_not_refreshed
# Allowed path (gate=1): the inherited process-env DSN is kept and used.
pass_if status_not_refreshed_uses_env_dsn_when_allowed grep -q 'dsn=matched' "$SENTRY_OUT"
if [ -f "$SENTRY_OUT" ] && grep -q 'status_unwritten' "$SENTRY_OUT"; then
  PASSES=$((PASSES + 1))
  echo "PASS status_not_refreshed_notifies_sentry"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL status_not_refreshed_notifies_sentry" >&2
fi

# Control: a successful write replaces a stale pass:true from a previous run.
write_env_creds
printf '{"timestamp":"2020-01-01T00:00:00Z","pass":true,"runId":"stale-run"}\n' >"$STATUS_JSON"
env -i \
  PATH="${PATH}" \
  HOME="${HOME:-/tmp}" \
  AWS_ACCESS_KEY_ID=env-key \
  AWS_SECRET_ACCESS_KEY=env-secret \
  ST_RESTORE_DRILL_TEST_ENV="$ENV_FILE" \
  ST_RESTORE_DRILL_NOTIFY=0 \
  ST_RESTORE_DRILL_USE_TIMEOUT=0 \
  ST_RESTORE_DRILL_SCRATCH_PARENT="$ST_RESTORE_DRILL_SCRATCH_PARENT" \
  ST_RESTORE_DRILL_STATUS_JSON="$STATUS_JSON" \
  ST_RESTORE_DRILL_STATE_DIR="$ST_RESTORE_DRILL_STATE_DIR" \
  ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1 \
  ST_RESTORE_DRILL_SENTRY_HELPER="$SENTRY_HELPER" \
  ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh" \
  STUB_DB_BYTES=1000 STUB_DF_FREE_KB=10000000 \
  STUB_DRILL_RC=0 STUB_INTEGRITY=ok STUB_DRILL_PASS=true \
  STUB_DRILL_SKIP_STATUS=0 \
  bash "$UNDER_TEST" >/dev/null 2>&1
REFRESH_RC=$?
if [ "$REFRESH_RC" -eq 0 ] && grep -q '"pass":true' "$STATUS_JSON" && ! grep -q 'stale-run' "$STATUS_JSON"; then
  PASSES=$((PASSES + 1))
  echo "PASS stale_status_replaced_on_success"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL stale_status_replaced_on_success (rc=${REFRESH_RC})" >&2
fi

# 5: Infisical stub supplies creds; file secrets are ignored (no allow gate).
write_env_creds
rm -f "${WORK}/access.out"
run_case infisical_creds 0 '
  export CASE_ALLOW_ENV_CREDS=0
  export CASE_AWS_ACCESS_KEY_ID=
  export CASE_AWS_SECRET_ACCESS_KEY=
  export STUB_ASSERT_ACCESS_KEY="${WORK}/access.out"
  export STUB_EXPECTED_ACCESS_KEY=infisical-key-id
'
assert_access_marker infisical_creds_used_stub_value
if output_leaks_secret; then
  FAILURES=$((FAILURES + 1))
  echo "FAIL infisical_creds_no_secret_in_logs" >&2
else
  PASSES=$((PASSES + 1))
  echo "PASS infisical_creds_no_secret_in_logs"
fi

# 5: missing token file fails closed and does not use leftover file secrets.
cat >"$ENV_FILE" <<MISSINGTOKEN
ST_RESTORE_DRILL_NOTIFY=0
ST_RESTORE_DRILL_STATE_DIR=${WORK}/state
ST_RESTORE_DRILL_STATUS_JSON=${STATUS_JSON}
AWS_S3_BUCKET_NAME=test-bucket
LIVE_DB=${LIVE_DB}
INFISICAL_TOKEN_FILE=/tmp/missing-st-restore-drill-token
INFISICAL_PROJECT_ID=test-project-id
AWS_ACCESS_KEY_ID=file-key-id
AWS_SECRET_ACCESS_KEY=file-secret-SHOULD-NOT-LEAK
MISSINGTOKEN
run_case infisical_missing_token 1 '
  export CASE_ALLOW_ENV_CREDS=0
  export CASE_NOTIFY=1
  export CASE_SENTRY_DSN=
'
check_failure_status infisical_missing_token
# Early config failures still carry this run's id.
pass_if infisical_missing_token_status_has_run_id grep -q '"runId":"' "$STATUS_JSON"
if printf '%s' "$LAST_OUT" | grep -q 'INFISICAL_TOKEN_FILE'; then
  PASSES=$((PASSES + 1))
  echo "PASS infisical_missing_token_names_file"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL infisical_missing_token_names_file" >&2
fi
if output_leaks_secret; then
  FAILURES=$((FAILURES + 1))
  echo "FAIL infisical_missing_token_no_secret_in_logs" >&2
else
  PASSES=$((PASSES + 1))
  echo "PASS infisical_missing_token_no_secret_in_logs"
fi

# 5: Infisical CLI failure fails closed.
write_env_creds
run_case infisical_cli_failure 1 '
  export CASE_ALLOW_ENV_CREDS=0
  export STUB_INFISICAL_FAIL=1
  export CASE_NOTIFY=1
  export CASE_SENTRY_DSN=
'
check_failure_status infisical_cli_failure
pass_if infisical_cli_failure_names_infisical grep -q 'B2 credentials were not available from Infisical' "$STATUS_JSON"

# 6: malformed env key must not abort with a raw bash error; must write pass:false and alert.
write_env_creds
printf 'export AWS_S3_BUCKET_NAME=bad-line\n1INVALID=nope\n' >>"$ENV_FILE"
run_case malformed_env_key 1 '
  export CASE_ALLOW_ENV_CREDS=1
  export CASE_AWS_ACCESS_KEY_ID=env-key
  export CASE_AWS_SECRET_ACCESS_KEY=env-secret
  export CASE_NOTIFY=1
  export CASE_SENTRY_DSN=https://test-dsn@example.test/1
'
check_failure_status malformed_env_key
if printf '%s' "$LAST_OUT" | grep -q 'malformed env line'; then
  PASSES=$((PASSES + 1))
  echo "PASS malformed_env_key_reports_line"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL malformed_env_key_reports_line" >&2
fi
if printf '%s' "$LAST_OUT" | grep -q 'invalid variable name'; then
  FAILURES=$((FAILURES + 1))
  echo "FAIL malformed_env_key_no_raw_bash_abort" >&2
else
  PASSES=$((PASSES + 1))
  echo "PASS malformed_env_key_no_raw_bash_abort"
fi
if [ -f "$SENTRY_OUT" ] && grep -q 'malformed_env' "$SENTRY_OUT"; then
  PASSES=$((PASSES + 1))
  echo "PASS malformed_env_key_notifies_sentry"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL malformed_env_key_notifies_sentry" >&2
fi
if output_leaks_secret || printf '%s' "$LAST_OUT" | grep -q 'file-secret-SHOULD-NOT-LEAK'; then
  FAILURES=$((FAILURES + 1))
  echo "FAIL malformed_env_key_no_secret_in_logs" >&2
else
  PASSES=$((PASSES + 1))
  echo "PASS malformed_env_key_no_secret_in_logs"
fi

# 7: inherited process-env AWS creds and DSN are dropped without the gate, so
# Infisical supplies both.  (The gate=1 path is env_first_credentials above.)
# Config-only env file: the inherited values are not also listed in the file.
write_env_config
run_case inherited_env_creds_ignored 2 '
  export CASE_ALLOW_ENV_CREDS=0
  export CASE_AWS_ACCESS_KEY_ID=inherited-env-key
  export CASE_AWS_SECRET_ACCESS_KEY=inherited-env-secret
  export CASE_SENTRY_DSN=https://inherited-dsn@example.test/2
  export CASE_NOTIFY=1
  export STUB_DRILL_RC=1
  export STUB_ASSERT_ACCESS_KEY="${WORK}/access.out"
  export STUB_EXPECTED_ACCESS_KEY=infisical-key-id
  export STUB_EXPECTED_DSN=https://infisical-dsn@example.test/9
'
assert_access_marker inherited_env_creds_ignored_uses_infisical_key
pass_if inherited_env_creds_ignored_uses_infisical_dsn grep -q 'dsn=matched' "$SENTRY_OUT"
pass_if inherited_env_creds_ignored_no_secret_in_logs \
  bash -c '! printf "%s" "$1" | grep -q "inherited-env-secret"' _ "$LAST_OUT"

# 8: token-file shape.  Fake tokens only.  A rejected token is never sent to
# Infisical (no stub call recorded) and never printed.
TOKEN_DIR="${WORK}/secrets"
make_token_file() {
  local path="$1" content="$2"
  printf '%s\n' "$content" >"$path"
  chmod 600 "$path"
}
run_token_case() {
  local name="$1" expect_rc="$2" token_path="$3"
  rm -f "${WORK}/infisical.calls"
  ENV_TOKEN_FILE="$token_path" write_env_config
  run_case "$name" "$expect_rc" '
    export CASE_ALLOW_ENV_CREDS=0
    export CASE_NOTIFY=1
    export STUB_INFISICAL_CALLS="${WORK}/infisical.calls"
  '
}
infisical_not_called() { [ ! -s "${WORK}/infisical.calls" ]; }

LONG_2045="$(printf '%*s' 2045 '' | tr ' ' 'x')"
make_token_file "${TOKEN_DIR}/ok-min.token" "st.fake-token-000020"
make_token_file "${TOKEN_DIR}/ok-max.token" "st.${LONG_2045}"
make_token_file "${TOKEN_DIR}/short.token" "st.fake-token-00019"
make_token_file "${TOKEN_DIR}/long.token" "st.${LONG_2045}x"
make_token_file "${TOKEN_DIR}/machine.token" "eyJfake.machine-identity-token-0000"
make_token_file "${TOKEN_DIR}/space.token" "st.fake service token 000000"
ln -sf "${TOKEN_DIR}/ok-min.token" "${TOKEN_DIR}/link.token"

run_token_case token_shape_accepts_20_chars 0 "${TOKEN_DIR}/ok-min.token"
run_token_case token_shape_accepts_2048_chars 0 "${TOKEN_DIR}/ok-max.token"
for bad in short long machine space link; do
  run_token_case "token_rejects_${bad}" 1 "${TOKEN_DIR}/${bad}.token"
  check_failure_status "token_rejects_${bad}"
  pass_if "token_rejects_${bad}_no_infisical_call" infisical_not_called
  pass_if "token_rejects_${bad}_no_token_in_logs" \
    bash -c '! printf "%s" "$1" | grep -Eq "fake-token|machine-identity-token|fake service token|xxxxxxxx"' _ "$LAST_OUT"
  if [ "$bad" = link ]; then
    pass_if token_rejects_link_names_symlink grep -q 'symbolic link' "$STATUS_JSON"
  else
    pass_if "token_rejects_${bad}_names_service_token" grep -q 'service token (st\.\*)' "$STATUS_JSON"
  fi
  pass_if "token_rejects_${bad}_status_has_run_id" grep -q '"runId":"' "$STATUS_JSON"
done

# 10: token-file failures alert.  A valid token with loose mode can still fetch
# the DSN from Infisical; a symlinked token is never used, so only a DSN that
# is already available (gate=1) can alert.
make_token_file "${TOKEN_DIR}/loose.token" "st.fake-token-loose-mode"
chmod 644 "${TOKEN_DIR}/loose.token"
ENV_TOKEN_FILE="${TOKEN_DIR}/loose.token" write_env_config
run_case token_mode_0644_alerts 1 '
  export CASE_ALLOW_ENV_CREDS=0
  export CASE_NOTIFY=1
  export STUB_EXPECTED_DSN=https://infisical-dsn@example.test/9
'
check_failure_status token_mode_0644_alerts
pass_if token_mode_0644_alerts_sentry grep -q 'token_file_invalid' "$SENTRY_OUT"
pass_if token_mode_0644_alerts_infisical_dsn grep -q 'dsn=matched' "$SENTRY_OUT"

ENV_TOKEN_FILE="${TOKEN_DIR}/link.token" write_env_config
run_case token_symlink_alerts_with_env_dsn 1 '
  export CASE_ALLOW_ENV_CREDS=1
  export CASE_NOTIFY=1
  export CASE_SENTRY_DSN=https://test-dsn@example.test/1
'
check_failure_status token_symlink_alerts_with_env_dsn
pass_if token_symlink_alerts_with_env_dsn_names_symlink grep -q 'symbolic link' "$STATUS_JSON"
pass_if token_symlink_alerts_with_env_dsn_sentry grep -q 'token_file_invalid' "$SENTRY_OUT"

# 11: INFISICAL_PROJECT_ID is required even when the Infisical CLI exists.
rm -f "${WORK}/infisical.calls"
ENV_PROJECT_ID='' write_env_config
run_case project_id_required_with_cli 1 '
  export CASE_ALLOW_ENV_CREDS=0
  export STUB_INFISICAL_CALLS="${WORK}/infisical.calls"
'
check_failure_status project_id_required_with_cli
pass_if project_id_required_with_cli_names_var grep -q 'INFISICAL_PROJECT_ID' "$STATUS_JSON"
pass_if project_id_required_with_cli_no_infisical_call infisical_not_called

# 3 + 4: installer strips every secret key (including the INFISICAL_ST_* pair)
# and drops `export ` prefixes from kept lines.  Fake values only.
INSTALLER="${SCRIPT_DIR}/install-st-litestream-restore-drill.sh"
STRIP_FN="$(sed -n '/^strip_secrets_from_env_file() {/,/^}/p' "$INSTALLER")"
STRIP_ENV="${WORK}/strip.env"
cat >"$STRIP_ENV" <<'STRIPENV'
# comment kept
export AWS_S3_BUCKET_NAME=fake-bucket
INFISICAL_PROJECT_ID=fake-project
INFISICAL_ST_CLIENT_ID=fake-st-client-id
export INFISICAL_ST_CLIENT_SECRET=fake-st-client-secret
INFISICAL_CLIENT_SECRET=fake-client-secret
AWS_SECRET_ACCESS_KEY=fake-aws-secret
STRIPENV
(eval "$STRIP_FN"; strip_secrets_from_env_file "$STRIP_ENV") >/dev/null
pass_if installer_strips_infisical_st_client_creds \
  bash -c '! grep -Eq "INFISICAL_ST_CLIENT|INFISICAL_CLIENT_SECRET|AWS_SECRET_ACCESS_KEY|fake-st-client|fake-aws-secret" "$1"' _ "$STRIP_ENV"
pass_if installer_drops_export_prefix \
  bash -c 'grep -qx "AWS_S3_BUCKET_NAME=fake-bucket" "$1" && ! grep -q "^[[:space:]]*export" "$1" && grep -qx "INFISICAL_PROJECT_ID=fake-project" "$1" && grep -qx "# comment kept" "$1"' _ "$STRIP_ENV"
write_env_config
cat "$STRIP_ENV" >>"$ENV_FILE"
rm -f "${WORK}/access.out"
run_case installer_output_loads_in_wrapper 0 '
  export CASE_ALLOW_ENV_CREDS=0
  export STUB_ASSERT_ACCESS_KEY="${WORK}/access.out"
  export STUB_EXPECTED_ACCESS_KEY=infisical-key-id
'
# Control: rc 0 must come from a real pass that used the Infisical key.
assert_access_marker installer_output_loads_in_wrapper_uses_infisical_key
pass_if installer_output_loads_in_wrapper_status_pass_true grep -q '"pass":true' "$STATUS_JSON"

# 7: SIGTERM writes pass:false AND notifies Sentry, then exits 143.
write_env_creds
rm -f "$STATUS_JSON" "$SENTRY_OUT"
TERM_LOG="${WORK}/term.log"
rm -f "$TERM_LOG"
env -i \
  PATH="${PATH}" \
  HOME="${HOME:-/tmp}" \
  AWS_ACCESS_KEY_ID=env-key \
  AWS_SECRET_ACCESS_KEY=env-secret \
  ST_RESTORE_DRILL_TEST_ENV="$ENV_FILE" \
  ST_RESTORE_DRILL_NOTIFY=1 \
  ST_RESTORE_DRILL_USE_TIMEOUT=0 \
  ST_RESTORE_DRILL_SCRATCH_PARENT="$ST_RESTORE_DRILL_SCRATCH_PARENT" \
  ST_RESTORE_DRILL_STATUS_JSON="$STATUS_JSON" \
  ST_RESTORE_DRILL_STATE_DIR="$ST_RESTORE_DRILL_STATE_DIR" \
  ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1 \
  ST_RESTORE_DRILL_SENTRY_HELPER="$SENTRY_HELPER" \
  STUB_SENTRY_OUT="$SENTRY_OUT" \
  SENTRY_FLEET_DSN=https://test-dsn@example.test/1 \
  ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh" \
  STUB_DB_BYTES=1000 STUB_DF_FREE_KB=10000000 \
  STUB_DRILL_SLEEP_SECONDS=8 \
  STUB_DRILL_RC=0 \
  bash "$UNDER_TEST" >"$TERM_LOG" 2>&1 &
term_pid=$!
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if grep -q 'scratch dir' "$TERM_LOG" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$term_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "WARN sigterm: wrapper did not reach scratch before signal (log follows)" >&2
  sed 's/^/  termlog: /' "$TERM_LOG" >&2 || true
fi
kill -TERM "$term_pid" 2>/dev/null || true
wait "$term_pid"
term_rc=$?
if [ "$term_rc" -eq 143 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS sigterm_exit_143"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL sigterm_exit_143 (rc=${term_rc})" >&2
fi
if [ -f "$STATUS_JSON" ] && grep -q '"pass":false' "$STATUS_JSON"; then
  PASSES=$((PASSES + 1))
  echo "PASS sigterm_status_pass_false"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL sigterm_status_pass_false" >&2
fi
if [ -f "$SENTRY_OUT" ] && grep -q 'terminated' "$SENTRY_OUT"; then
  PASSES=$((PASSES + 1))
  echo "PASS sigterm_notifies_sentry"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL sigterm_notifies_sentry" >&2
fi

# 1: the helper routes HUP/INT/TERM through its cleanup trap and offers --cleanup
# to recover from a SIGKILL that left the drop-in behind.
pass_if notify_off_helper_traps_signals_and_has_cleanup \
  bash -c 'grep -q "trap .exit 143. TERM" "$1" && grep -q "trap .exit 130. INT" "$1" && grep -q "trap .exit 129. HUP" "$1" && grep -q -- "--cleanup" "$1"' _ "${SCRIPT_DIR}/st-litestream-restore-drill-start-notify-off.sh"

# Helper script must use a /run drop-in and must not patch the persistent env file.
HELPER="${SCRIPT_DIR}/st-litestream-restore-drill-start-notify-off.sh"
if [ -f "$HELPER" ] && grep -q '/run/systemd/system/' "$HELPER" && grep -qx 'ExecStart=' "$HELPER" && grep -qF 'ExecStart=/usr/bin/env ST_RESTORE_DRILL_NOTIFY=0 ${WRAPPER}' "$HELPER" && ! grep -q '^Environment=ST_RESTORE_DRILL_NOTIFY' "$HELPER" && ! grep -qE 'sed |tee ' "$HELPER"; then
  PASSES=$((PASSES + 1))
  echo "PASS notify_off_helper_uses_runtime_dropin"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL notify_off_helper_uses_runtime_dropin" >&2
fi

# F2: the helper's wrapper path matches the unit's ExecStart, and a
# process-environment NOTIFY=0 (what `env ST_RESTORE_DRILL_NOTIFY=0` sets) wins
# over an env file that ships ST_RESTORE_DRILL_NOTIFY=1.
helper_wrapper="$(sed -n 's/^WRAPPER="\(.*\)"$/\1/p' "$HELPER")"
unit_exec="$(sed -n 's/^ExecStart=//p' "${SCRIPT_DIR}/st-litestream-restore-drill.service")"
pass_if notify_off_helper_wrapper_matches_unit_execstart test -n "$helper_wrapper" -a "$helper_wrapper" = "$unit_exec"
ENV_NOTIFY=1 write_env_config
run_case notify_off_env_beats_env_file_notify_1 2 '
  export CASE_ALLOW_ENV_CREDS=1
  export CASE_AWS_ACCESS_KEY_ID=env-key
  export CASE_AWS_SECRET_ACCESS_KEY=env-secret
  export CASE_NOTIFY=0
  export CASE_SENTRY_DSN=https://test-dsn@example.test/1
  export STUB_DRILL_RC=1
'
pass_if notify_off_env_beats_env_file_no_sentry test ! -e "$SENTRY_OUT"
pass_if notify_off_env_beats_env_file_logs_skip bash -c 'printf "%s" "$1" | grep -q "notify skipped (ST_RESTORE_DRILL_NOTIFY=0)"' _ "$LAST_OUT"
# Control: the same run with NOTIFY=1 in the process environment does alert.
ENV_NOTIFY=1 write_env_config
run_case notify_on_control 2 '
  export CASE_ALLOW_ENV_CREDS=1
  export CASE_AWS_ACCESS_KEY_ID=env-key
  export CASE_AWS_SECRET_ACCESS_KEY=env-secret
  export CASE_NOTIFY=1
  export CASE_SENTRY_DSN=https://test-dsn@example.test/1
  export STUB_DRILL_RC=1
'
pass_if notify_on_control_sentry grep -q 'drill_failed' "$SENTRY_OUT"

# F7: a B2 secret missing from Infisical alerts Sentry before the pass:false write.
write_env_config
run_case b2_missing_alerts 1 '
  export CASE_ALLOW_ENV_CREDS=0
  export CASE_NOTIFY=1
  export STUB_INFISICAL_MISSING=AWS_SECRET_ACCESS_KEY
  export STUB_EXPECTED_DSN=https://infisical-dsn@example.test/9
'
check_failure_status b2_missing_alerts
pass_if b2_missing_alerts_names_infisical grep -q 'B2 credentials were not available from Infisical' "$STATUS_JSON"
pass_if b2_missing_alerts_sentry grep -q 'credentials_unavailable' "$SENTRY_OUT"
pass_if b2_missing_alerts_infisical_dsn grep -q 'dsn=matched' "$SENTRY_OUT"

# F8: the env-credential gate does not depend on line order in the env file.
# Credential lines first, gate last, no process-environment gate.
write_env_creds
printf 'ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1\n' >>"$ENV_FILE"
rm -f "${WORK}/access.out"
run_case env_gate_after_cred_lines 0 '
  export CASE_ALLOW_ENV_CREDS=
  export STUB_ASSERT_ACCESS_KEY="${WORK}/access.out"
  export STUB_EXPECTED_ACCESS_KEY=file-key-id
'
assert_access_marker env_gate_after_cred_lines_uses_file_key
# Control: a non-empty process value still wins over the file (env-first).
write_env_creds
printf 'ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1\n' >>"$ENV_FILE"
rm -f "${WORK}/access.out"
run_case env_gate_process_zero_wins 0 '
  export CASE_ALLOW_ENV_CREDS=0
  export STUB_ASSERT_ACCESS_KEY="${WORK}/access.out"
  export STUB_EXPECTED_ACCESS_KEY=infisical-key-id
'
assert_access_marker env_gate_process_zero_wins_uses_infisical_key

# F5: a plain-HTTP INFISICAL_DOMAIN is refused before any Infisical call.
rm -f "${WORK}/infisical.calls"
write_env_config
sed -i 's#^INFISICAL_DOMAIN=.*#INFISICAL_DOMAIN=http://app.infisical.com#' "$ENV_FILE"
run_case infisical_domain_http_refused 1 '
  export CASE_ALLOW_ENV_CREDS=0
  export STUB_INFISICAL_CALLS="${WORK}/infisical.calls"
'
check_failure_status infisical_domain_http_refused
pass_if infisical_domain_http_refused_names_var grep -q 'INFISICAL_DOMAIN must be an https:// URL' "$STATUS_JSON"
pass_if infisical_domain_http_refused_no_infisical_call infisical_not_called

# F5: the HTTP API fallback refuses a cross-origin redirect and never forwards
# the token.  Runs the wrapper's own Python block against local TLS servers
# with a throwaway self-signed certificate.  Fake token only.
API_PY="${WORK}/infisical-api.py"
sed -n "/python3 - <<'PY'/,/^PY\$/p" "$UNDER_TEST" | sed '1d;$d' >"$API_PY"
if command -v openssl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && [ -s "$API_PY" ]; then
  TLS_DIR="${WORK}/tls"
  mkdir -p "$TLS_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
    -keyout "${TLS_DIR}/key.pem" -out "${TLS_DIR}/cert.pem" >/dev/null 2>&1
  cat >"${TLS_DIR}/servers.py" <<'SRV'
import http.server, ssl, sys, threading, pathlib
d = pathlib.Path(sys.argv[1])
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(d / "cert.pem", d / "key.pem")
class Sink(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        (d / "sink.hit").write_text("auth" if self.headers.get("Authorization") else "noauth")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"secret":{"secretValue":"leaked"}}')
    def log_message(self, *a): pass
sink = http.server.HTTPServer(("127.0.0.1", 0), Sink)
sink.socket = ctx.wrap_socket(sink.socket, server_side=True)
class Redir(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "https://localhost:%d/x" % sink.server_port)
        self.end_headers()
    def log_message(self, *a): pass
redir = http.server.HTTPServer(("127.0.0.1", 0), Redir)
redir.socket = ctx.wrap_socket(redir.socket, server_side=True)
for s in (sink, redir):
    threading.Thread(target=s.serve_forever, daemon=True).start()
(d / "port").write_text(str(redir.server_port))
threading.Event().wait(30)
SRV
  python3 "${TLS_DIR}/servers.py" "$TLS_DIR" &
  srv_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -s "${TLS_DIR}/port" ] && break
    sleep 0.2
  done
  API_OUT="$(
    env -i PATH="$PATH" SSL_CERT_FILE="${TLS_DIR}/cert.pem" \
      ST_INFISICAL_SECRET_NAME=AWS_ACCESS_KEY_ID \
      ST_INFISICAL_TOKEN_FILE="$TOKEN_FILE" \
      ST_INFISICAL_DOMAIN="https://127.0.0.1:$(cat "${TLS_DIR}/port" 2>/dev/null)" \
      ST_INFISICAL_PROJECT_ID=test-project-id \
      ST_INFISICAL_ENV=prod ST_INFISICAL_SECRET_PATH=/ \
      python3 "$API_PY" 2>&1
  )"
  api_rc=$?
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true
  pass_if infisical_api_refuses_cross_origin_redirect test "$api_rc" -ne 0
  pass_if infisical_api_redirect_names_refusal bash -c 'printf "%s" "$1" | grep -q "refused a redirect"' _ "$API_OUT"
  pass_if infisical_api_redirect_token_not_forwarded test ! -e "${TLS_DIR}/sink.hit"
  pass_if infisical_api_redirect_no_value_printed bash -c '! printf "%s" "$1" | grep -q leaked' _ "$API_OUT"
  # Control: the same block refuses a plain-HTTP domain outright.
  API_HTTP_OUT="$(env -i PATH="$PATH" ST_INFISICAL_SECRET_NAME=AWS_ACCESS_KEY_ID ST_INFISICAL_TOKEN_FILE="$TOKEN_FILE" \
    ST_INFISICAL_DOMAIN=http://127.0.0.1:9 ST_INFISICAL_PROJECT_ID=test-project-id python3 "$API_PY" 2>&1)"
  pass_if infisical_api_refuses_http_domain bash -c 'printf "%s" "$1" | grep -q "must use https://"' _ "$API_HTTP_OUT"
else
  echo "SKIP infisical_api_redirect (needs openssl and python3)"
fi

# F6: a token file owned by another uid is refused before it is read or sent.
OWNER_TOKEN="${TOKEN_DIR}/other-owner.token"
make_token_file "$OWNER_TOKEN" "st.fake-token-other-owner"
chown_ok=0
if [ "$(id -u)" -eq 0 ]; then
  chown 65534 "$OWNER_TOKEN" 2>/dev/null && chown_ok=1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n chown 65534 "$OWNER_TOKEN" 2>/dev/null && chown_ok=1
fi
if [ "$chown_ok" -eq 1 ]; then
  run_token_case token_rejects_other_owner 1 "$OWNER_TOKEN"
  check_failure_status token_rejects_other_owner
  pass_if token_rejects_other_owner_names_owner grep -q 'must be owned by the user running the drill' "$STATUS_JSON"
  pass_if token_rejects_other_owner_no_infisical_call infisical_not_called
  if [ "$(id -u)" -eq 0 ]; then rm -f "$OWNER_TOKEN"; else sudo -n rm -f "$OWNER_TOKEN" 2>/dev/null || true; fi
else
  echo "SKIP token_rejects_other_owner (needs root or passwordless sudo to chown)"
fi
# Control: a token file this user owns passes the owner check (token_shape_accepts_20_chars above).

echo "selftest: ${PASSES} passed, ${FAILURES} failed."
[ "$FAILURES" -eq 0 ]

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
mkdir -p "$STUB_DIR" "${WORK}/scratch" "${WORK}/ops"
STATUS_JSON="${WORK}/status.json"
ENV_FILE="${WORK}/st-litestream-restore-drill.env"
LIVE_DB="${WORK}/live.app.db"
printf 'x' >"$LIVE_DB"

export ST_RESTORE_DRILL_TEST_ENV="$ENV_FILE"
export ST_RESTORE_DRILL_NOTIFY=0
export ST_RESTORE_DRILL_USE_TIMEOUT=0
export ST_RESTORE_DRILL_SCRATCH_PARENT="${WORK}/scratch"
export ST_RESTORE_DRILL_STATE_DIR="${WORK}/state"
export ST_RESTORE_DRILL_STATUS_JSON="$STATUS_JSON"
mkdir -p "${WORK}/state"

write_env_creds() {
  cat >"$ENV_FILE" <<EOF
ST_RESTORE_DRILL_NOTIFY=0
ST_RESTORE_DRILL_STATE_DIR=${WORK}/state
ST_RESTORE_DRILL_STATUS_JSON=${STATUS_JSON}
AWS_S3_BUCKET_NAME=test-bucket
AWS_ACCESS_KEY_ID=test-key-id
AWS_SECRET_ACCESS_KEY=test-secret
LIVE_DB=${LIVE_DB}
EOF
}

# stat stub: live db size is STUB_DB_BYTES (default 1000).
cat >"${STUB_DIR}/stat" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-c" && "${2:-}" == "%s" ]]; then
  printf '%s\n' "${STUB_DB_BYTES:-1000}"
  exit 0
fi
exec /usr/bin/stat "$@"
STUB
chmod +x "${STUB_DIR}/stat"

# df stub: free KiB blocks in field 4 via STUB_DF_FREE_KB.
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

# Stub drill: exit STUB_DRILL_RC and optionally write status JSON.
cat >"${WORK}/stub-drill.sh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${RESTORE_DRILL_STATUS_JSON:-}" ]]; then
  integrity="${STUB_INTEGRITY:-ok}"
  pass="${STUB_DRILL_PASS:-true}"
  printf '{"timestamp":"2026-01-01T00:00:00Z","durationSeconds":1,"restoredSizeBytes":1000,"integrity":"%s","rowCountDeltas":{},"pass":%s}\n' \
    "$integrity" "$pass" >"${RESTORE_DRILL_STATUS_JSON}.tmp"
  mv "${RESTORE_DRILL_STATUS_JSON}.tmp" "${RESTORE_DRILL_STATUS_JSON}"
fi
if [[ -n "${STUB_CREATE_SCRATCH_FILE:-}" ]]; then
  touch "${SCRATCH_DIR}/app.db.restore-drill-stub"
fi
exit "${STUB_DRILL_RC:-0}"
STUB
chmod +x "${WORK}/stub-drill.sh"

export PATH="${STUB_DIR}:${PATH}"

PASSES=0
FAILURES=0

run_case() {
  local name="$1" expect_rc="$2"
  shift 2
  rm -f "$STATUS_JSON"
  find "${WORK}/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r d; do rm -rf "$d"; done
  export STUB_DB_BYTES=1000 STUB_DF_FREE_KB=10000000
  export STUB_DRILL_RC=0 STUB_INTEGRITY=ok STUB_DRILL_PASS=true STUB_CREATE_SCRATCH_FILE=
  eval "$@"
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
  env -i \
    PATH="${PATH}" \
    HOME="${HOME:-/tmp}" \
    ST_RESTORE_DRILL_TEST_ENV="$ST_RESTORE_DRILL_TEST_ENV" \
    ST_RESTORE_DRILL_NOTIFY="$ST_RESTORE_DRILL_NOTIFY" \
    ST_RESTORE_DRILL_USE_TIMEOUT="$ST_RESTORE_DRILL_USE_TIMEOUT" \
    ST_RESTORE_DRILL_SCRATCH_PARENT="$ST_RESTORE_DRILL_SCRATCH_PARENT" \
    ST_RESTORE_DRILL_STATUS_JSON="$ST_RESTORE_DRILL_STATUS_JSON" \
    ST_RESTORE_DRILL_STATE_DIR="$ST_RESTORE_DRILL_STATE_DIR" \
    ST_LITESTREAM_RESTORE_DRILL_SCRIPT="$ST_LITESTREAM_RESTORE_DRILL_SCRIPT" \
    STUB_DB_BYTES="$STUB_DB_BYTES" \
    STUB_DF_FREE_KB="$STUB_DF_FREE_KB" \
    STUB_DRILL_RC="${STUB_DRILL_RC:-0}" \
    STUB_INTEGRITY="${STUB_INTEGRITY:-ok}" \
    STUB_DRILL_PASS="${STUB_DRILL_PASS:-true}" \
    STUB_CREATE_SCRATCH_FILE="${STUB_CREATE_SCRATCH_FILE:-}" \
    bash "$UNDER_TEST" >/dev/null 2>&1
  rc=$?
  local left
  left="$(find "${WORK}/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  if [ "$rc" -eq "$expect_rc" ]; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name} (rc=${rc}, scratch_dirs=${left})"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name} (expected rc=${expect_rc}, got ${rc}, scratch_dirs=${left})" >&2
  fi
}

write_env_creds

run_case missing_creds 1 '
  rm -f "$ENV_FILE"
  touch "$ENV_FILE"
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
'

write_env_creds
run_case low_disk 1 '
  export STUB_DF_FREE_KB=1
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
'

write_env_creds
run_case pass 0 '
  export STUB_DRILL_RC=0
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
'

write_env_creds
run_case integrity_fail 2 '
  export STUB_DRILL_RC=1
  export STUB_INTEGRITY=fail
  export STUB_DRILL_PASS=false
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
'

write_env_creds
run_case cleanup_on_failure 2 '
  export STUB_DRILL_RC=1
  export STUB_CREATE_SCRATCH_FILE=1
  export ST_LITESTREAM_RESTORE_DRILL_SCRIPT="${WORK}/stub-drill.sh"
'
# cleanup_on_failure: wrapper removes mktemp parent; stub file inside should be gone with parent
after_left="$(find "${WORK}/scratch" -name "app.db.restore-drill-stub" 2>/dev/null | wc -l)"
if [ "$after_left" -eq 0 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS scratch_file_removed"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL scratch_file_removed (stub files=${after_left})" >&2
fi

echo "selftest: ${PASSES} passed, ${FAILURES} failed."
[ "$FAILURES" -eq 0 ]

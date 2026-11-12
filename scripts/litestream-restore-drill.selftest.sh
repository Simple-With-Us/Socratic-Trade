#!/usr/bin/env bash
# litestream-restore-drill.selftest.sh - status write + scratch cleanup (hermetic).
#
# Usage: bash scripts/litestream-restore-drill.selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/litestream-restore-drill.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/litestream-restore-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

STUB_DIR="${WORK}/bin"
mkdir -p "$STUB_DIR" "${WORK}/scratch" "${WORK}/ok"
printf 'live' >"${WORK}/live.db"

export PATH="${STUB_DIR}:${PATH}"
export AWS_S3_BUCKET_NAME=test-bucket
export AWS_ACCESS_KEY_ID=test-key
export AWS_SECRET_ACCESS_KEY=test-secret
export LIVE_DB="${WORK}/live.db"
export LITESTREAM_CONFIG="${WORK}/litestream.yml"
export SCRATCH_DIR="${WORK}/scratch"
export RESTORE_DRILL_MIN_FREE_TENTHS=10
export RESTORE_DRILL_RUN_ID="selftest-run-writable"

printf 'dbs:\n' >"$LITESTREAM_CONFIG"

cat >"${STUB_DIR}/litestream" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  version) echo "stub 0.5.16"; exit 0 ;;
  restore)
    while [ $# -gt 0 ]; do
      case "$1" in
        -o) touch "$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    exit 0
    ;;
  *) exit 0 ;;
esac
STUB
chmod +x "${STUB_DIR}/litestream"

cat >"${STUB_DIR}/sqlite3" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *integrity_check*) printf 'ok\n'; exit 0 ;;
  *) printf '1\n'; exit 0 ;;
esac
STUB
chmod +x "${STUB_DIR}/sqlite3"

cat >"${STUB_DIR}/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1K-blocks Used Available Use Mounted on\nstub 99999999 1 99999999 1%% %s\n' "${2:-/}"
STUB
chmod +x "${STUB_DIR}/df"

scratch_left() {
  find "${WORK}/scratch" -name 'app.db.restore-drill-*' 2>/dev/null | wc -l
}

PASSES=0
FAILURES=0
pass() { PASSES=$((PASSES + 1)); echo "PASS $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "FAIL $1" >&2; }

# Control: a writable status path must actually produce a status file.
export RESTORE_DRILL_STATUS_JSON="${WORK}/ok/status.json"
set +e
writable_out="$(bash "$UNDER_TEST" 2>&1)"
writable_rc=$?
set -e
if [ "$writable_rc" -eq 0 ] && [ -f "${WORK}/ok/status.json" ] && grep -q '"pass":true' "${WORK}/ok/status.json" && grep -q 'selftest-run-writable' "${WORK}/ok/status.json"; then
  pass "writable_status_path_writes_file"
else
  fail "writable_status_path_writes_file (rc=${writable_rc}, file_exists=$([ -f "${WORK}/ok/status.json" ] && echo yes || echo no))"
fi
if [ "$(scratch_left)" -eq 0 ]; then
  pass "scratch_removed_on_writable_status_write"
else
  fail "scratch_removed_on_writable_status_write"
fi

# Failure fixture that stays unwritable even as root: the parent path is a regular file,
# so mkdir -p cannot create it and the status write must fail.  chmod 500 on a root-owned
# directory is not a reliable fixture.
touch "${WORK}/not-a-dir"
export RESTORE_DRILL_STATUS_JSON="${WORK}/not-a-dir/status.json"
export RESTORE_DRILL_RUN_ID="selftest-run-unwritable"
set +e
unwritable_out="$(bash "$UNDER_TEST" 2>&1)"
unwritable_rc=$?
set -e

# Control assertion: the fixture is active — the unwritable path must not produce a status file,
# the script must say so, and it must exit non-zero.
if [ ! -e "${WORK}/not-a-dir/status.json" ] && [ "$unwritable_rc" -ne 0 ] && printf '%s' "$unwritable_out" | grep -q 'status JSON not written'; then
  pass "unwritable_status_path_fixture_active"
else
  fail "unwritable_status_path_fixture_active (rc=${unwritable_rc}, leaked=$([ -e "${WORK}/not-a-dir/status.json" ] && echo yes || echo no))"
fi
if [ "$(scratch_left)" -eq 0 ]; then
  pass "scratch_removed_on_status_write_failure"
else
  fail "scratch_removed_on_status_write_failure (scratch still present)"
fi

# The unwritable run must not print secret values (the exported test keys).
if printf '%s' "$unwritable_out" | grep -q 'test-secret'; then
  fail "unwritable_run_did_not_print_secret"
else
  pass "unwritable_run_did_not_print_secret"
fi

echo "selftest: ${PASSES} passed, ${FAILURES} failed."
[ "$FAILURES" -eq 0 ]

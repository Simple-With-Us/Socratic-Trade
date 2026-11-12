#!/usr/bin/env bash
# litestream-restore-drill.selftest.sh - status-write failure still removes scratch (hermetic).
#
# Usage: bash scripts/litestream-restore-drill.selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/litestream-restore-drill.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/litestream-restore-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

STUB_DIR="${WORK}/bin"
mkdir -p "$STUB_DIR" "${WORK}/scratch" "${WORK}/ro"
printf 'live' >"${WORK}/live.db"
chmod 500 "${WORK}/ro"

export PATH="${STUB_DIR}:${PATH}"
export AWS_S3_BUCKET_NAME=test-bucket
export AWS_ACCESS_KEY_ID=test-key
export AWS_SECRET_ACCESS_KEY=test-secret
export LIVE_DB="${WORK}/live.db"
export LITESTREAM_CONFIG="${WORK}/litestream.yml"
export SCRATCH_DIR="${WORK}/scratch"
export RESTORE_DRILL_STATUS_JSON="${WORK}/ro/status.json"
export RESTORE_DRILL_MIN_FREE_TENTHS=10

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

set +e
bash "$UNDER_TEST" >/dev/null 2>&1
set -e

if [ "$(find "${WORK}/scratch" -name 'app.db.restore-drill-*' 2>/dev/null | wc -l)" -eq 0 ]; then
  echo "PASS scratch_removed_on_status_write_failure"
  exit 0
fi
echo "FAIL scratch_removed_on_status_write_failure (scratch still present)" >&2
exit 1

#!/usr/bin/env bash
# st-container-restart-monitor.selftest.sh - hermetic matrix (stub docker + temp state).
#
# Usage: bash scripts/ops/st-container-restart-monitor.selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/st-container-restart-monitor.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq required." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/st-restart-monitor-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

STUB_DIR="${WORK}/bin"
mkdir -p "$STUB_DIR"
STATE_PATH="${WORK}/state.json"
export ST_RESTART_MONITOR_STATE_PATH="$STATE_PATH"
export ST_RESTART_MONITOR_NOTIFY=0
export ST_RESTART_MONITOR_WINDOW_SECONDS=900
export ST_RESTART_MONITOR_DELTA_THRESHOLD=3
export ST_RESTART_MONITOR_COOLIFY_ID=testuuid

# docker stub: reads STUB_DOCKER_* env set by each case.
cat > "${STUB_DIR}/docker" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
case "${1:-}" in
  ps)
    if [ "${2:-}" = "-aq" ]; then
      printf '%s\n' "${STUB_DOCKER_PS_ID:-}"
      exit 0
    fi
    ;;
  inspect)
    if [ "${2:-}" = "-f" ]; then
      case "${3:-}" in
        '{{.RestartCount}}') printf '%s' "${STUB_DOCKER_RESTART_COUNT:-0}"; exit 0 ;;
        '{{.State.Status}}') printf '%s' "${STUB_DOCKER_STATUS:-running}"; exit 0 ;;
        '{{.State.StartedAt}}') printf '%s' "${STUB_DOCKER_STARTED:-2026-01-01T00:00:00Z}"; exit 0 ;;
        '{{.State.ExitCode}}') printf '%s' "${STUB_DOCKER_EXIT:-0}"; exit 0 ;;
        '{{.Name}}') printf '%s' "${STUB_DOCKER_NAME:-/st-test}"; exit 0 ;;
      esac
    fi
    ;;
esac
echo "stub docker: unhandled $*" >&2
exit 1
STUB
chmod +x "${STUB_DIR}/docker"

export PATH="${STUB_DIR}:${PATH}"

PASSES=0
FAILURES=0

run_case() {
  local name="$1" expect_rc="$2"
  shift 2
  rm -f "$STATE_PATH"
  eval "$@"
  set +e
  rc=0
  bash "$UNDER_TEST" >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq "$expect_rc" ]; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name} (rc=${rc})"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name} (expected rc=${expect_rc}, got ${rc})" >&2
  fi
}

# Baseline: container present, no alert.
run_case baseline_ok 0 \
  'export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=0 STUB_DOCKER_STATUS=running'

# Three restart steps in window -> alert path (notify off -> still rc 2).
run_case restart_loop 2 "
  export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=0 STUB_DOCKER_STATUS=running
  bash \"${UNDER_TEST}\" >/dev/null 2>&1 || true
  export STUB_DOCKER_RESTART_COUNT=1; bash \"${UNDER_TEST}\" >/dev/null 2>&1 || true
  export STUB_DOCKER_RESTART_COUNT=2; bash \"${UNDER_TEST}\" >/dev/null 2>&1 || true
  export STUB_DOCKER_RESTART_COUNT=3
"

# Missing after seen -> alert.
run_case missing_container 2 "
  export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=1
  bash \"${UNDER_TEST}\" >/dev/null 2>&1 || true
  export STUB_DOCKER_PS_ID=
"

echo "selftest: ${PASSES} passed, ${FAILURES} failed."
[ "$FAILURES" -eq 0 ]

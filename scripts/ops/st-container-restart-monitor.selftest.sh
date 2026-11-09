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
    # -q is live containers only. -aq includes exited/dead.
    case "${2:-}" in
      -q)
        case "${STUB_DOCKER_STATUS:-running}" in
          exited|dead) printf '\n'; exit 0 ;;
        esac
        printf '%s\n' "${STUB_DOCKER_PS_ID:-}"
        exit 0
        ;;
      -aq)
        printf '%s\n' "${STUB_DOCKER_PS_ID:-}"
        exit 0
        ;;
    esac
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
  export STUB_DOCKER_PS_ID= STUB_DOCKER_RESTART_COUNT=0 STUB_DOCKER_STATUS=running STUB_DOCKER_EXIT=0
  eval "$@"
  # Do not enable errexit here. The harness is `set -uo pipefail` only; a leaked
  # `set -e` aborts later cases before the summary line.
  bash "$UNDER_TEST" >/dev/null 2>&1
  rc=$?
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

# Terminal state is an alert even when RestartCount is flat.
run_case terminal_exited 2 \
  'export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=1 STUB_DOCKER_STATUS=exited STUB_DOCKER_EXIT=137'

# A replaced container must not inherit the previous id's restarting status.
run_case id_change_clears_restarting 0 "
  export STUB_DOCKER_PS_ID=oldcid STUB_DOCKER_RESTART_COUNT=4 STUB_DOCKER_STATUS=restarting
  bash \"${UNDER_TEST}\" >/dev/null 2>&1 || true
  export STUB_DOCKER_PS_ID=newcid STUB_DOCKER_RESTART_COUNT=0 STUB_DOCKER_STATUS=restarting
"

# One jq range() call records the whole delta (threshold is 3).
run_case large_delta 2 "
  export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=0 STUB_DOCKER_STATUS=running
  bash \"${UNDER_TEST}\" >/dev/null 2>&1 || true
  export STUB_DOCKER_RESTART_COUNT=40
"

# missingSince stays at the first missing sample across a later sample.
rm -f "$STATE_PATH"
export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=1 STUB_DOCKER_STATUS=running
bash "$UNDER_TEST" >/dev/null 2>&1 || true
export STUB_DOCKER_PS_ID=
bash "$UNDER_TEST" >/dev/null 2>&1 || true
first_missing="$(jq -r '.missingSince' "$STATE_PATH")"
sleep 1
bash "$UNDER_TEST" >/dev/null 2>&1 || true
second_missing="$(jq -r '.missingSince' "$STATE_PATH")"
if [ -n "$first_missing" ] && [ "$first_missing" != "null" ] && [ "$first_missing" = "$second_missing" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS missing_since_sticky"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL missing_since_sticky (first=${first_missing} second=${second_missing})" >&2
fi

# Cooldown arms only after a channel delivers, and the Pushover secret stays off argv.
export ST_RESTART_MONITOR_NOTIFY=1
export PUSHOVER_ST_API_TOKEN=testtoken
export PUSHOVER_USER_KEY=testuser
unset SENTRY_FLEET_DSN || true
cat > "${STUB_DIR}/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *testtoken*|*testuser*) echo "secret in argv" >&2; exit 2 ;;
  esac
done
cat > "${STUB_CURL_BODY:?}"
exit 0
STUB
chmod +x "${STUB_DIR}/curl"
export STUB_CURL_BODY="${WORK}/curl-body"
rm -f "$STATE_PATH" "$STUB_CURL_BODY"
export STUB_DOCKER_PS_ID=abc123 STUB_DOCKER_RESTART_COUNT=1 STUB_DOCKER_STATUS=exited STUB_DOCKER_EXIT=1
bash "$UNDER_TEST" >/dev/null 2>&1
deliver_rc=$?
armed="$(jq -r '.lastAlertAt // 0' "$STATE_PATH")"
body="$(cat "$STUB_CURL_BODY" 2>/dev/null || true)"
bash "$UNDER_TEST" >/dev/null 2>&1
cooldown_rc=$?
if [ "$deliver_rc" -eq 2 ] && [ "$armed" != "0" ] && [ "$cooldown_rc" -eq 0 ] \
  && printf '%s' "$body" | grep -q 'token=testtoken' \
  && printf '%s' "$body" | grep -q 'user=testuser'; then
  PASSES=$((PASSES + 1))
  echo "PASS pushover_stdin_and_cooldown"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL pushover_stdin_and_cooldown (deliver=${deliver_rc} armed=${armed} cooldown=${cooldown_rc} body=${body})" >&2
fi

# Failed post and skipped channels must not arm the cooldown.
cat > "${STUB_DIR}/curl" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "${STUB_DIR}/curl"
rm -f "$STATE_PATH"
bash "$UNDER_TEST" >/dev/null 2>&1
fail_rc=$?
fail_armed="$(jq -r '.lastAlertAt // 0' "$STATE_PATH")"
unset PUSHOVER_ST_API_TOKEN PUSHOVER_USER_KEY
rm -f "$STATE_PATH"
bash "$UNDER_TEST" >/dev/null 2>&1
skip_rc=$?
skip_armed="$(jq -r '.lastAlertAt // 0' "$STATE_PATH")"
if [ "$fail_rc" -eq 2 ] && [ "$fail_armed" = "0" ] && [ "$skip_rc" -eq 2 ] && [ "$skip_armed" = "0" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS cooldown_not_armed_without_delivery"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL cooldown_not_armed_without_delivery (fail=${fail_rc}/${fail_armed} skip=${skip_rc}/${skip_armed})" >&2
fi
export ST_RESTART_MONITOR_NOTIFY=0
rm -f "${STUB_DIR}/curl"

echo "selftest: ${PASSES} passed, ${FAILURES} failed."
[ "$FAILURES" -eq 0 ]

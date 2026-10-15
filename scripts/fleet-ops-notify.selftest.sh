#!/usr/bin/env bash
# fleet-ops-notify.selftest.sh - hermetic tests (mock agent-sync, no live Zulip).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/fleet-ops-notify.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fleet-ops-notify-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

MOCK_LOG="${WORK}/mock.log"
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/agent-sync" <<MOCK
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${MOCK_LOG}"
exit 0
MOCK
chmod +x "${WORK}/bin/agent-sync"

PASSES=0
FAILURES=0

run_case() {
  local name="$1" want_code="$2"
  shift 2
  rm -f "$MOCK_LOG"
  local out code
  out="$(
    export PATH="${WORK}/bin:${PATH}"
    export HOME="${WORK}/home"
    mkdir -p "${HOME}/.secrets/Zulip"
    printf 'email=test@example.invalid\nkey=fake\nsite=https://example.invalid\n' > "${HOME}/.secrets/Zulip/ST-zuliprc"
    for assign in "$@"; do export "$assign"; done
    bash "$UNDER_TEST" post "SEVERE test line." 2>&1
  )"
  code=$?
  if [ "$code" = "$want_code" ]; then
    echo "PASS  ${name} (exit ${code})"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL  ${name} (exit ${code}, wanted ${want_code})"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  fi
}

run_case "dry-run skips agent-sync" 0 FLEET_OPS_NOTIFY_DRY_RUN=1
if [ -f "$MOCK_LOG" ]; then
  echo "FAIL  dry-run should not invoke agent-sync"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS  dry-run did not invoke agent-sync"
  PASSES=$((PASSES + 1))
fi

run_case "posts via mock agent-sync" 0
if [ -s "$MOCK_LOG" ] && grep -q 'post' "$MOCK_LOG"; then
  echo "PASS  mock received post"
  PASSES=$((PASSES + 1))
else
  echo "FAIL  mock log missing post"
  FAILURES=$((FAILURES + 1))
fi

mkdir -p "${WORK}/empty-home"
run_case "missing credentials is soft skip" 0 AGENT_SEAT=ST HOME="${WORK}/empty-home"

echo "---- ${PASSES} passed, ${FAILURES} failed ----"
[ "$FAILURES" = "0" ]

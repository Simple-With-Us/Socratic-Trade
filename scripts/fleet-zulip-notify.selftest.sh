#!/usr/bin/env bash
# fleet-zulip-notify.selftest.sh - hermetic checks (no Zulip, no network).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/fleet-zulip-notify.sh"
[ -x "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }

PASSES=0
FAILURES=0

run_case() {
  local name="$1" want="$2"
  shift 2
  local out code
  out="$(
    for assign in "$@"; do export "$assign"; done
    bash "$UNDER_TEST" post --topic "selftest" --no-tag -- "hello" 2>&1
  )"
  code=$?
  if [ "$code" = "$want" ]; then
    echo "PASS  ${name} (exit ${code})"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL  ${name} (exit ${code}, wanted ${want})"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  fi
}

run_case "dry-run posts without creds" 0 FLEET_NOTIFY_DRY_RUN=1
run_case "missing creds is no-op" 0

echo "---- ${PASSES} passed, ${FAILURES} failed ----"
[ "$FAILURES" = "0" ]

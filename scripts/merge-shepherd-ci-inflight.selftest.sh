#!/usr/bin/env bash
# Contract tests for merge-shepherd ci_in_flight guard (ST-2874).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${ROOT}/scripts/merge-shepherd.sh"

bash -n "$SCRIPT"

# Extract ci_in_flight from the shepherd script for isolated tests.
eval "$(sed -n '/^ci_in_flight()/,/^}/p' "$SCRIPT")"

fail=0
assert_in_flight() {
  local running="$1" verify="$2"
  if ci_in_flight "$running" "$verify"; then
    return 0
  fi
  echo "FAIL expected in-flight running=$running verify=$verify" >&2
  fail=1
}

assert_idle() {
  local running="$1" verify="$2"
  if ! ci_in_flight "$running" "$verify"; then
    return 0
  fi
  echo "FAIL expected idle running=$running verify=$verify" >&2
  fail=1
}

assert_in_flight 1 SUCCESS
assert_in_flight 0 IN_PROGRESS
assert_in_flight 0 QUEUED
assert_idle 0 SUCCESS
assert_idle 0 NONE
assert_idle 0 FAILURE
assert_idle 0 NEUTRAL
assert_idle 0 SKIPPED

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "selftest: merge-shepherd ci_in_flight ok"

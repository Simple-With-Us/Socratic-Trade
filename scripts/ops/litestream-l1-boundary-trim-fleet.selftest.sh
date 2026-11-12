#!/usr/bin/env bash
# litestream-l1-boundary-trim-fleet.selftest.sh - stub the trim binary.
#
# Usage: bash scripts/ops/litestream-l1-boundary-trim-fleet.selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/litestream-l1-boundary-trim-fleet.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/l1-trim-fleet-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

STUB="${WORK}/trim"
CALLS="${WORK}/calls"
cat > "$STUB" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CALLS:?}"
exit 0
STUB
chmod +x "$STUB"

PASSES=0
FAILURES=0

run_case() {
  local name="$1" expect_rc="$2"
  shift 2
  rm -f "$CALLS"
  (
    unset LITESTREAM_L1_TRIM_APPLY LITESTREAM_L1_TRIM_BIN LITESTREAM_L1_TRIM_MAX_SNAPSHOT_AGE_HOURS
    export CALLS
    # shellcheck disable=SC2086
    eval "$@"
    bash "$UNDER_TEST" >"${WORK}/out" 2>"${WORK}/err"
    echo $? >"${WORK}/rc"
  )
  rc="$(cat "${WORK}/rc")"
  if [ "$rc" -eq "$expect_rc" ]; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name} (rc=${rc})"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name} (expected rc=${expect_rc}, got ${rc})" >&2
    sed -n '1,40p' "${WORK}/err" >&2 || true
  fi
}

# Default is dry-run: three apps, no --apply, age default 6.
run_case dry_run_default 0 "export LITESTREAM_L1_TRIM_BIN='$STUB'"
if [ -f "$CALLS" ] && [ "$(wc -l < "$CALLS")" -eq 3 ] \
  && ! grep -q -- '--apply' "$CALLS" \
  && grep -q -- '--app socratic --max-snapshot-age-hours 6' "$CALLS" \
  && grep -q -- '--app congress --max-snapshot-age-hours 6' "$CALLS" \
  && grep -q -- '--app usage-monitor --max-snapshot-age-hours 6' "$CALLS"; then
  PASSES=$((PASSES + 1))
  echo "PASS dry_run_args"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL dry_run_args" >&2
  cat "$CALLS" >&2 || true
fi

# APPLY=0 is the same dry-run.
run_case apply_zero_stays_dry 0 "export LITESTREAM_L1_TRIM_BIN='$STUB' LITESTREAM_L1_TRIM_APPLY=0"
if [ -f "$CALLS" ] && ! grep -q -- '--apply' "$CALLS"; then
  PASSES=$((PASSES + 1))
  echo "PASS apply_zero_args"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL apply_zero_args" >&2
fi

# The timer opts in with LITESTREAM_L1_TRIM_APPLY=1.
run_case apply_env 0 "export LITESTREAM_L1_TRIM_BIN='$STUB' LITESTREAM_L1_TRIM_APPLY=1"
if [ -f "$CALLS" ] && [ "$(grep -c -- '--apply' "$CALLS")" -eq 3 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS apply_env_args"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL apply_env_args" >&2
  cat "$CALLS" >&2 || true
fi

# Missing trim binary.  The unset-override case runs a copy of the script whose
# default path points into $WORK, so the result never depends on whether the
# host has the real binary installed (hermetic on the fleet host too).
DEFAULT_BIN='/usr/local/sbin/litestream-l1-boundary-trim'
grep -qF -- "-${DEFAULT_BIN}}" "$UNDER_TEST" || {
  echo "error: default trim path not found in ${UNDER_TEST}" >&2
  exit 1
}
HERMETIC="${WORK}/fleet-hermetic.sh"
sed "s#-${DEFAULT_BIN}}#-${WORK}/no-default-trim}#" "$UNDER_TEST" > "$HERMETIC"
REAL_UNDER_TEST="$UNDER_TEST"
UNDER_TEST="$HERMETIC"
run_case missing_default_bin 127 "unset LITESTREAM_L1_TRIM_BIN"
# An explicit empty override fails closed (127), even when the default
# exists: put a stub at the default path and prove it is not run.
cp "$STUB" "${WORK}/no-default-trim"
run_case missing_empty_bin 127 "export LITESTREAM_L1_TRIM_BIN="
if [ ! -f "$CALLS" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS empty_bin_does_not_run_default"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL empty_bin_does_not_run_default" >&2
fi
# Control: with the override unset, the same hermetic copy runs the default.
run_case default_bin_runs 0 "unset LITESTREAM_L1_TRIM_BIN"
if [ -f "$CALLS" ] && [ "$(wc -l < "$CALLS")" -eq 3 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS default_bin_args"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL default_bin_args" >&2
fi
rm -f "${WORK}/no-default-trim"
UNDER_TEST="$REAL_UNDER_TEST"
run_case missing_path 127 "export LITESTREAM_L1_TRIM_BIN='${WORK}/no-such-trim'"

# A bad opt-in value fails before the trim binary is executed.
run_case bad_apply_env 2 "export LITESTREAM_L1_TRIM_BIN='$STUB' LITESTREAM_L1_TRIM_APPLY=yes"
if [ ! -f "$CALLS" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS bad_apply_does_not_run"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL bad_apply_does_not_run" >&2
fi

echo "litestream-l1-boundary-trim-fleet.selftest: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" -eq 0 ]

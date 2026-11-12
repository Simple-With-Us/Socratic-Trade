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
app=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--app" ]; then
    app="$arg"
  fi
  prev="$arg"
done
key="TRIM_RC_${app//-/_}"
if [ -n "${!key+x}" ]; then
  exit "${!key}"
fi
exit "${TRIM_RC:-0}"
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
    unset TRIM_RC TRIM_RC_socratic TRIM_RC_congress TRIM_RC_usage_monitor
    export CALLS
    # env applies the name=value arguments without eval or export "$@".
    env "$@" bash "$UNDER_TEST" >"${WORK}/out" 2>"${WORK}/err"
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

expect_three_calls() {
  local name="$1"
  if [ -f "$CALLS" ] && [ "$(wc -l < "$CALLS")" -eq 3 ]; then
    PASSES=$((PASSES + 1))
    echo "PASS ${name}"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL ${name}" >&2
    cat "$CALLS" >&2 || true
  fi
}

# Default is dry-run: three apps, no --apply, age default 6.
run_case dry_run_default 0 LITESTREAM_L1_TRIM_BIN="$STUB"
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
run_case apply_zero_stays_dry 0 LITESTREAM_L1_TRIM_BIN="$STUB" LITESTREAM_L1_TRIM_APPLY=0
if [ -f "$CALLS" ] && ! grep -q -- '--apply' "$CALLS"; then
  PASSES=$((PASSES + 1))
  echo "PASS apply_zero_args"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL apply_zero_args" >&2
fi

# The timer opts in with LITESTREAM_L1_TRIM_APPLY=1.
run_case apply_env 0 LITESTREAM_L1_TRIM_BIN="$STUB" LITESTREAM_L1_TRIM_APPLY=1
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

# The installer must put the trim binary exactly where the wrapper defaults
# to, or every scheduled run exits 127.  Read both literals from the repo
# files (no host access) and fail on any drift.
INSTALLER="${SCRIPT_DIR}/install-litestream-l1-trim.sh"
[ -f "$INSTALLER" ] || { echo "error: ${INSTALLER} not found." >&2; exit 1; }
# paths_agree <installer> <wrapper>: 0 only when DST_PY, the wrapper's
# LITESTREAM_L1_TRIM_BIN default, and DEFAULT_BIN are one identical path.
paths_agree() {
  local dst def
  dst="$(sed -n 's/^DST_PY="\(.*\)"$/\1/p' "$1")"
  # shellcheck disable=SC2016  # literal ${...} is the pattern, not an expansion
  def="$(sed -n 's/^TRIM="\${LITESTREAM_L1_TRIM_BIN-\(.*\)}"$/\1/p' "$2")"
  PATHS_SEEN="installer DST_PY='${dst}' wrapper default='${def}' DEFAULT_BIN='${DEFAULT_BIN}'"
  [ -n "$dst" ] && [ -n "$def" ] \
    && [ "$(printf '%s\n' "$dst" | wc -l)" -eq 1 ] \
    && [ "$(printf '%s\n' "$def" | wc -l)" -eq 1 ] \
    && [ "$dst" = "$def" ] && [ "$def" = "$DEFAULT_BIN" ]
}
if paths_agree "$INSTALLER" "$UNDER_TEST"; then
  PASSES=$((PASSES + 1))
  echo "PASS installer_dst_matches_wrapper_default"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL installer_dst_matches_wrapper_default: ${PATHS_SEEN}" >&2
fi
# Control: a copy of the installer with DST_PY moved must be caught.
sed 's#^DST_PY=".*"$#DST_PY="/opt/drifted/litestream-l1-boundary-trim"#' "$INSTALLER" > "${WORK}/installer-drifted.sh"
if ! paths_agree "${WORK}/installer-drifted.sh" "$UNDER_TEST"; then
  PASSES=$((PASSES + 1))
  echo "PASS installer_drift_detected"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL installer_drift_detected: ${PATHS_SEEN}" >&2
fi

# The installer must also put the fleet wrapper exactly where the systemd unit
# starts it (DST_FLEET == ExecStart), or the nightly timer fails to start.
SERVICE_UNIT="${SCRIPT_DIR}/litestream-l1-boundary-trim.service"
[ -f "$SERVICE_UNIT" ] || { echo "error: ${SERVICE_UNIT} not found." >&2; exit 1; }
# fleet_paths_agree <installer> <unit>: 0 only when the installer's DST_FLEET
# and the unit's single ExecStart executable are one identical absolute path.
fleet_paths_agree() {
  local fleet exec_lines exec_bin
  fleet="$(sed -n 's/^DST_FLEET="\(.*\)"$/\1/p' "$1")"
  exec_lines="$(grep -c '^ExecStart=' "$2")"
  # Executable is the first word; drop systemd's -@:+! prefixes.
  exec_bin="$(sed -n 's/^ExecStart=[-@:+!]*\([^[:space:]]*\).*$/\1/p' "$2")"
  PATHS_SEEN="installer DST_FLEET='${fleet}' unit ExecStart='${exec_bin}' (ExecStart lines: ${exec_lines})"
  [ -n "$fleet" ] && [ "${fleet#/}" != "$fleet" ] \
    && [ "$(printf '%s\n' "$fleet" | wc -l)" -eq 1 ] \
    && [ "$exec_lines" -eq 1 ] && [ "$fleet" = "$exec_bin" ]
}
if fleet_paths_agree "$INSTALLER" "$SERVICE_UNIT"; then
  PASSES=$((PASSES + 1))
  echo "PASS installer_fleet_matches_unit_execstart"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL installer_fleet_matches_unit_execstart: ${PATHS_SEEN}" >&2
fi
# Controls: moving DST_FLEET alone, or the unit's ExecStart alone, must be caught.
sed 's#^DST_FLEET=".*"$#DST_FLEET="/opt/drifted/litestream-l1-boundary-trim-fleet"#' "$INSTALLER" > "${WORK}/installer-fleet-drifted.sh"
sed 's#^ExecStart=.*$#ExecStart=/opt/drifted/litestream-l1-boundary-trim-fleet#' "$SERVICE_UNIT" > "${WORK}/unit-drifted.service"
if ! fleet_paths_agree "${WORK}/installer-fleet-drifted.sh" "$SERVICE_UNIT" \
  && ! fleet_paths_agree "$INSTALLER" "${WORK}/unit-drifted.service"; then
  PASSES=$((PASSES + 1))
  echo "PASS installer_fleet_drift_detected"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL installer_fleet_drift_detected: ${PATHS_SEEN}" >&2
fi
HERMETIC="${WORK}/fleet-hermetic.sh"
sed "s#-${DEFAULT_BIN}}#-${WORK}/no-default-trim}#" "$UNDER_TEST" > "$HERMETIC"
REAL_UNDER_TEST="$UNDER_TEST"
UNDER_TEST="$HERMETIC"
run_case missing_default_bin 127
# An explicit empty override fails closed (127), even when the default
# exists: put a stub at the default path and prove it is not run.
cp "$STUB" "${WORK}/no-default-trim"
run_case missing_empty_bin 127 LITESTREAM_L1_TRIM_BIN=
if [ ! -f "$CALLS" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS empty_bin_does_not_run_default"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL empty_bin_does_not_run_default" >&2
fi
# Control: with the override unset, the same hermetic copy runs the default.
run_case default_bin_runs 0
if [ -f "$CALLS" ] && [ "$(wc -l < "$CALLS")" -eq 3 ]; then
  PASSES=$((PASSES + 1))
  echo "PASS default_bin_args"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL default_bin_args" >&2
fi
rm -f "${WORK}/no-default-trim"
UNDER_TEST="$REAL_UNDER_TEST"
run_case missing_path 127 LITESTREAM_L1_TRIM_BIN="${WORK}/no-such-trim"

# A searchable directory (and any other non-regular file) must not reach
# bash's exec-126 path; treat it as the same missing-executable 127.
mkdir -m 755 "${WORK}/trim-dir"
run_case trim_bin_is_directory 127 LITESTREAM_L1_TRIM_BIN="${WORK}/trim-dir"
if [ ! -f "$CALLS" ] && grep -qF "missing executable ${WORK}/trim-dir (not a regular file)" "${WORK}/err"; then
  PASSES=$((PASSES + 1))
  echo "PASS trim_bin_is_directory_logs"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL trim_bin_is_directory_logs" >&2
  sed -n '1,40p' "${WORK}/err" >&2 || true
  cat "$CALLS" >&2 || true
fi
mkfifo "${WORK}/trim-fifo"
chmod 755 "${WORK}/trim-fifo"
run_case trim_bin_is_fifo 127 LITESTREAM_L1_TRIM_BIN="${WORK}/trim-fifo"
if [ ! -f "$CALLS" ] && grep -qF "missing executable ${WORK}/trim-fifo (not a regular file)" "${WORK}/err"; then
  PASSES=$((PASSES + 1))
  echo "PASS trim_bin_is_fifo_logs"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL trim_bin_is_fifo_logs" >&2
  sed -n '1,40p' "${WORK}/err" >&2 || true
  cat "$CALLS" >&2 || true
fi


# A symlink to a regular executable still counts (the -f check follows it).
# Pin this so a later guard that rejects symlinks cannot stay green.
ln -s "$STUB" "${WORK}/trim-link"
run_case trim_bin_is_symlink 0 LITESTREAM_L1_TRIM_BIN="${WORK}/trim-link"
expect_three_calls trim_bin_is_symlink_runs

# A bad opt-in value fails before the trim binary is executed.
run_case bad_apply_env 2 LITESTREAM_L1_TRIM_BIN="$STUB" LITESTREAM_L1_TRIM_APPLY=yes
if [ ! -f "$CALLS" ]; then
  PASSES=$((PASSES + 1))
  echo "PASS bad_apply_does_not_run"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL bad_apply_does_not_run" >&2
fi

# Each trim guard (and trim exit 1, including APPLIED-UNVERIFIED) must pass
# through the wrapper, and later apps still run.
for code in 1 2 3 4 5 6 126; do
  run_case "passthrough_${code}" "$code" LITESTREAM_L1_TRIM_BIN="$STUB" TRIM_RC="$code"
  expect_three_calls "passthrough_${code}_runs_remaining"
  if grep -q "app=socratic failed rc=${code}" "${WORK}/err"; then
    PASSES=$((PASSES + 1))
    echo "PASS passthrough_${code}_logs_rc"
  else
    FAILURES=$((FAILURES + 1))
    echo "FAIL passthrough_${code}_logs_rc" >&2
    sed -n '1,40p' "${WORK}/err" >&2 || true
  fi
done


# Voluntary TRIM_RC=126 is still covered above.  A real failed exec needs a
# second stub: executable shebang whose interpreter is mode 0644, so the
# kernel returns EACCES and bash surfaces 126.
INTERP="${WORK}/noexec-interp"
printf '%s\n' 'not-an-interpreter' > "$INTERP"
chmod 0644 "$INTERP"
FAIL_EXEC="${WORK}/trim-failexec"
printf '%s\n' "#!${INTERP}" > "$FAIL_EXEC"
chmod 0755 "$FAIL_EXEC"
run_case failed_exec_126 126 LITESTREAM_L1_TRIM_BIN="$FAIL_EXEC"
if grep -qF "app=socratic failed rc=126" "${WORK}/err"; then
  PASSES=$((PASSES + 1))
  echo "PASS failed_exec_126_logs"
else
  FAILURES=$((FAILURES + 1))
  echo "FAIL failed_exec_126_logs" >&2
  sed -n '1,40p' "${WORK}/err" >&2 || true
fi

# First non-zero wins: a later different failure does not replace it.
run_case first_nonzero_wins 3 \
  LITESTREAM_L1_TRIM_BIN="$STUB" TRIM_RC_socratic=3 TRIM_RC_congress=5 TRIM_RC_usage_monitor=6
expect_three_calls first_nonzero_wins_runs_remaining

# A leading success does not hide a later guard abort.
run_case later_nonzero_after_success 4 \
  LITESTREAM_L1_TRIM_BIN="$STUB" TRIM_RC_socratic=0 TRIM_RC_congress=4 TRIM_RC_usage_monitor=6
expect_three_calls later_nonzero_after_success_runs_remaining

echo "litestream-l1-boundary-trim-fleet.selftest: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" -eq 0 ]

#!/usr/bin/env bash
# test-ship-seq.sh - Offline tests for ship-testflight.sh's build-number rules.
#
# Covers the two defects fixed on 2026-08-12:
#   1. ORDERING: a run rejected by the ship gate must NOT consume a build
#      sequence number. It used to: the gate was evaluated after the counter had
#      already been advanced, so a rate-limited attempt burned a version that
#      shipped nowhere (observed live: skipped at 4392s of a 9000s interval, and
#      the sequence still went 5 -> 6).
#   2. SCHEME: CFBundleVersion must be a UTC YYYYMMDDHHMM stamp, not a copy of
#      the marketing version. App Store Connect renders "<marketing> (<build>)",
#      so copying made the parenthetical useless AND put a number far lower than
#      the 15 live timestamp builds into play, which Apple rejects if a ship
#      lands back in an older marketing train.
#
# Everything runs offline against scratch state:
#   HOME                -> scratch (so no real home files exist and App Store
#                          Connect is never contacted; also makes it impossible
#                          for a test to touch the real ~/.cache/ios-fleet)
#   IOS_FLEET_STATE_DIR -> scratch sequence + last-ship files
#   PATH                -> a fake `xcodebuild` that refuses to archive
# No network, no Xcode, no credentials. Runs on macOS and Linux.
#
# Usage:
#   bash scripts/ios-fleet/test-ship-seq.sh
#
# Exit 0 = all pass. Exit 1 = at least one failure (details on stdout).
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHIP="${SCRIPT_DIR}/ship-testflight.sh"
[[ -f "$SHIP" ]] || { echo "missing $SHIP"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-seq-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKE_HOME="${WORK}/home"
FAKE_BIN="${WORK}/bin"
STATE="${WORK}/state"
REPO="${WORK}/repo"
mkdir -p "$FAKE_HOME" "$FAKE_BIN" "$STATE" "$REPO"

# A fake xcodebuild: answers -version, and hard-fails on anything else so a test
# can never start a real archive.
cat >"${FAKE_BIN}/xcodebuild" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "-version" ]]; then
  echo "Xcode 26.0"
  echo "Build version 17A000"
  exit 0
fi
echo "FAKE xcodebuild called with: $*" >&2
exit 99
FAKE
chmod +x "${FAKE_BIN}/xcodebuild"

# A stub fleet-secrets that always reports "absent", so ASC credentials stay unset and no test
# can reach the real Infisical (the script falls back to fleet-secrets on PATH).
printf '#!/usr/bin/env bash\nexit 3\n' >"${FAKE_BIN}/fleet-secrets"
chmod +x "${FAKE_BIN}/fleet-secrets"
export FLEET_SECRETS="${FAKE_BIN}/fleet-secrets"

# A tiny clean git repo so repo_head_sha() has a real, stable SHA.
git -C "$REPO" init -q 2>/dev/null || git -C "$REPO" init >/dev/null
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "seq test"
echo seed >"${REPO}/README"
git -C "$REPO" add README
git -C "$REPO" -c commit.gpgsign=false commit -qm seed
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

SEQ_FILE="${STATE}/build-seq-congress.txt"
SHIP_FILE="${STATE}/last-ship-congress.txt"

PASS=0
FAIL=0
OUT=""
RC=0

# run_ship <args...> - invoke ship-testflight.sh in the sandbox.
run_ship() {
  OUT="$(env -i \
    HOME="$FAKE_HOME" \
    PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="${WORK}/tmp" \
    IOS_FLEET_STATE_DIR="$STATE" \
    bash "$SHIP" "$@" 2>&1)"
  RC=$?
  return 0
}

ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1"
  echo "        ---- output ----"
  printf '%s\n' "$OUT" | sed 's/^/        /'
  echo "        ---- end (rc=${RC}) ----"
}

check() { # check <desc> <condition-result 0/1>
  if [[ "$2" -eq 0 ]]; then ok "$1"; else bad "$1"; fi
}

seq_now() { cat "$SEQ_FILE" 2>/dev/null || echo MISSING; }
# Literal substring. grep is a bad fit here: skip lines carry a UTF-8 em-dash
# (C-locale grep then treats the stream as binary) and marketing/build
# needles contain '.' / '()'.
contains() { [[ "$OUT" == *"$1"* ]]; }

reset_state() {
  rm -f "$SEQ_FILE" "$SHIP_FILE"
  printf '5' >"$SEQ_FILE"
}

echo "ship-testflight.sh build-sequence tests"
echo "state=${STATE}"
echo

# --- 1. Rate-limited run must not consume ----------------------------------
echo "1. ship gate: rate-limited run does not consume a build number"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq
check "exits 0 (nothing to do)" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the rate-limit skip" "$(contains 'ship-gate: skip' && echo 0 || echo 1)"
check "sequence still 5 (was 5 -> 6 before the fix)" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "names the override (IOS_TF_MIN_INTERVAL_SEC / --force-ship)" \
  "$(contains 'IOS_TF_MIN_INTERVAL_SEC' && contains 'force-ship' && echo 0 || echo 1)"
check "names the 3600s default and where it lives" \
  "$(contains '3600s' && contains 'DEFAULT_MIN_INTERVAL_SEC' && echo 0 || echo 1)"
check "skips the App Store Connect round trip entirely" \
  "$(contains 'seq sources:' && echo 1 || echo 0)"
echo

# --- 2. Same-HEAD run must not consume -------------------------------------
echo "2. ship gate: already-shipped HEAD does not consume a build number"
reset_state
printf '%s %s\n' "1" "$HEAD_SHA" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the same-HEAD skip" "$(contains 'already shipped' && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 3. A run the gate allows still consumes exactly one -------------------
echo "3. ship gate: an allowed run consumes exactly one build number"
reset_state
run_ship congress --repo-root "$REPO" --allow-unverified-seq
check "proceeds past the gate" "$(contains 'no prior ship' && echo 0 || echo 1)"
check "stops at the missing project (never archives)" \
  "$(contains 'project not found' && echo 0 || echo 1)"
check "sequence advanced 5 -> 6, exactly once" \
  "$([[ "$(seq_now)" == "6" ]] && echo 0 || echo 1)"
echo

# --- 4. --dry-run must not consume -----------------------------------------
echo "4. --dry-run does not consume a build number"
reset_state
run_ship congress --repo-root "$REPO" --allow-unverified-seq --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "plans the next version 1.0.6" "$(contains 'marketing=1.0.6' && echo 0 || echo 1)"
echo

# --- 5. --dry-run reports a gated run without consuming --------------------
echo "5. --dry-run still reports the gate outcome"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "says the gate would skip" "$(contains 'would SKIP' && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 6. --upload-only must not consume -------------------------------------
echo "6. --upload-only does not consume a build number"
reset_state
: >"${WORK}/fake.ipa"
run_ship congress --repo-root "$REPO" --upload-only "${WORK}/fake.ipa"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "says the version comes from the IPA" \
  "$(contains 'from the existing IPA' && echo 0 || echo 1)"
echo

# --- 7. --force-ship still bypasses the gate and still consumes ------------
echo "7. --force-ship bypasses the gate (and consumes, as it should)"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq --force-ship
check "bypasses the gate" "$(contains 'bypassing min-interval' && echo 0 || echo 1)"
check "sequence advanced 5 -> 6" "$([[ "$(seq_now)" == "6" ]] && echo 0 || echo 1)"
echo

# --- 8. Version scheme, all four fleet apps --------------------------------
# The highest CFBundleVersion already live on trade.congress.ios (15 timestamp
# builds run 202608070253 .. 202608120521). A new stamp must exceed it, or a
# ship that lands back in the 1.0.0 train is rejected by Apple.
HIGHEST_LIVE_TIMESTAMP_BUILD=202608120521
echo "8. version scheme: 1.0.N marketing + UTC YYYYMMDDHHMM build, all four apps"
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  printf '5' >"${STATE}/build-seq-${app}.txt"
  run_ship "$app" --repo-root "$REPO" --allow-unverified-seq --dry-run
  line="$(printf '%s' "$OUT" | grep -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  mk="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  bn="$(printf '%s' "$line" | sed 's/^.* build=//')"

  check "${app}: marketing is a 1.0.N train value (got '${mk}')" \
    "$(printf '%s' "$mk" | grep -Eq '^1\.0\.[0-9]+$' && echo 0 || echo 1)"
  check "${app}: build is a 12-digit UTC stamp (got '${bn}')" \
    "$(printf '%s' "$bn" | grep -Eq '^[0-9]{12}$' && echo 0 || echo 1)"
  check "${app}: build is not a copy of marketing (no more '1.0.N (1.0.N)')" \
    "$([[ "$bn" != "$mk" ]] && echo 0 || echo 1)"
  check "${app}: build exceeds the highest live legacy build ${HIGHEST_LIVE_TIMESTAMP_BUILD}" \
    "$([[ "${bn:-0}" -gt "$HIGHEST_LIVE_TIMESTAMP_BUILD" ]] 2>/dev/null && echo 0 || echo 1)"
  check "${app}: reports the App Store Connect rendering" \
    "$(contains "will show this as: ${mk} (${bn})" && echo 0 || echo 1)"
done
echo

# --- 9. Marketing version increments by exactly 1 per allowed ship ---------
echo "9. marketing version increments by exactly 1 per allowed ship"
rm -f "$SEQ_FILE" "$SHIP_FILE"
printf '5' >"$SEQ_FILE"
seen=""
for i in 1 2 3; do
  run_ship congress --repo-root "$REPO" --allow-unverified-seq
  seen="${seen} $(seq_now)"
done
check "three allowed runs give 6 7 8 (got:${seen})" \
  "$([[ "$seen" == " 6 7 8" ]] && echo 0 || echo 1)"
echo

# --- 10. Standing 1-hour gate: just-under skips, at-or-over proceeds -------
# Owner 2026-08-14: unbuilt iOS updates may ship as often as once per hour.
# Pin both sides of the boundary so a future edit of DEFAULT_MIN_INTERVAL_SEC
# cannot silently restore 2.5h (or drop the gate) without this suite going red.
# A different HEAD is required so this is not the same-HEAD skip.
# Margins (3000 / 3700) absorb the second that passes between writing the
# state file and the script reading `date +%s`.
echo "10. 1-hour standing gate: 3000s still skips; 3700s proceeds"
reset_state
printf '%s %s\n' "$(( $(date +%s) - 3000 ))" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq
check "3000s ago is still gated" "$(contains 'ship-gate: skip' && echo 0 || echo 1)"
check "3000s ago does not consume a number" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
reset_state
printf '%s %s\n' "$(( $(date +%s) - 3700 ))" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq
check "3700s ago proceeds past the gate" "$(contains 'ship-gate: skip' && echo 1 || echo 0)"
check "3700s ago consumes exactly one number" "$([[ "$(seq_now)" == "6" ]] && echo 0 || echo 1)"
echo

# --- 11. ASC unverified die-text names local sequence when it exists ------
# Run 33023012786 printed "there is no local sequence" while local=72.
echo "11. unverified ASC die-text reports existing local sequence"
reset_state
run_ship congress --repo-root "$REPO"
check "exits 1 without --allow-unverified-seq" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "does not claim there is no local sequence" \
  "$(contains 'there is no local sequence' && echo 1 || echo 0)"
check "names the local sequence that exists" \
  "$(contains 'local=5' && echo 0 || echo 1)"
echo

echo "----------------------------------------"
echo "passed: ${PASS}   failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0

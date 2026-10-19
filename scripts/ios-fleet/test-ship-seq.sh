#!/usr/bin/env bash
# test-ship-seq.sh - Offline tests for ship-testflight.sh's build-number rules.
#
# Covers the two defects fixed on 2026-08-12:
#   1. ORDERING: a run rejected by the ship gate must NOT consume a build
#      sequence number. It used to: the gate was evaluated after the counter had
#      already been advanced, so a rate-limited attempt burned a version that
#      shipped nowhere (observed live: skipped at 4392s of a 9000s interval, and
#      the sequence still went 5 -> 6).
#   2. SCHEME: the build number is the repo commit count, and the marketing
#      version is 1.0.<commit count> beside it, so the pair always describes
#      one number. App Store Connect renders "<marketing> (<build>)". The
#      strictly-increasing guard raises the build to floor + 1 when the floor
#      is already at or above the commit count, and the marketing version
#      moves with it. UTC YYYYMMDDHHMM stamps are retired.
#   3. COUNTER: the local build-seq counter is retired. Under the commit-count
#      scheme it is never advanced and it no longer feeds the floor, so a
#      leftover from the retired timestamp scheme cannot push the build number
#      above the commit count it names. The committed version record is the
#      floor input instead.
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
# Seed enough commits that the repo's commit count sits ABOVE the state floor
# these tests use (5), so the normal path is exercised: the build number is
# the commit count and the guard does not fire. With a one-commit fixture the
# floor wins and every version assertion ends up testing the guard instead of
# the scheme.
_seed=2
while [ "$_seed" -le 6 ]; do
  echo "seed $_seed" >>"${REPO}/README"
  git -C "$REPO" add README
  git -C "$REPO" -c commit.gpgsign=false commit -qm "seed $_seed"
  _seed=$((_seed + 1))
done
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
# Owner directive 2026-10-18 (#2801): marketing is 1.0.<commit_count>. Read the
# count from the fixture instead of hard-coding it, so adding a seed commit to
# the harness cannot silently stale section 4 a second time.
COMMIT_COUNT="$(git -C "$REPO" rev-list --count HEAD)"

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

# The committed version record is the floor input the guard tests drive.  Under
# the commit-count scheme the local build-seq counter is retired, so the record
# in project.pbxproj is what resolve_seq_floor() reads.  The paths below are
# the projectRel entries in this repo's scripts/ios-fleet/apps.json.
project_rel() { # <app key>
  case "$1" in
    socratic)          printf '%s' 'ios/Socratic Trade.xcodeproj' ;;
    congress)          printf '%s' 'clients/ios/CongressTrade.xcodeproj' ;;
    usage|usage-local) printf '%s' 'ios/UsageMonitor/UsageMonitor.xcodeproj' ;;
    *)                 return 1 ;;
  esac
}

write_record() { # <app key> <record N>
  local rel dir
  rel="$(project_rel "$1")" || return 1
  dir="${REPO}/${rel}"
  mkdir -p "$dir"
  {
    echo '/* fixture project.pbxproj */'
    echo "        CURRENT_PROJECT_VERSION = ${2};"
    echo "        MARKETING_VERSION = 1.0.${2};"
  } >"${dir}/project.pbxproj"
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

# --- 3. A run the gate allows does not advance the counter -----------------
echo "3. ship gate: an allowed run proceeds without advancing the counter"
reset_state
run_ship congress --repo-root "$REPO" --allow-unverified-seq
check "proceeds past the gate" "$(contains 'no prior ship' && echo 0 || echo 1)"
check "stops at the missing project (never archives)" \
  "$(contains 'project not found' && echo 0 || echo 1)"
check "the local counter is not advanced (it is not the build number now)" \
  "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "the planned build number is the commit count" \
  "$(contains "marketing=1.0.${COMMIT_COUNT}" && echo 0 || echo 1)"
echo

# --- 4. --dry-run must not consume -----------------------------------------
echo "4. --dry-run does not consume a build number"
reset_state
run_ship congress --repo-root "$REPO" --allow-unverified-seq --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "plans the next version 1.0.${COMMIT_COUNT}" \
  "$(contains "marketing=1.0.${COMMIT_COUNT}" && echo 0 || echo 1)"
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

# --- 7. --force-ship still bypasses the gate ------------------------------
echo "7. --force-ship bypasses the gate"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-unverified-seq --force-ship
check "bypasses the gate" "$(contains 'bypassing min-interval' && echo 0 || echo 1)"
check "the local counter is still not advanced" \
  "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 8. Version scheme: 1.0.<commit_count> marketing and build, all four apps
SECTION8_FLOOR=5
echo "8. version scheme: 1.0.<commit_count> marketing and build, all four apps"
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  printf '%s' "$SECTION8_FLOOR" >"${STATE}/build-seq-${app}.txt"
  run_ship "$app" --repo-root "$REPO" --allow-unverified-seq --dry-run
  line="$(printf '%s' "$OUT" | grep -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  mk="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  bn="$(printf '%s' "$line" | sed 's/^.* build=//')"

  check "${app}: marketing is 1.0.N on the commit-count train (got '${mk}')" \
    "$(printf '%s' "$mk" | grep -Eq '^1\.0\.[0-9]+$' && echo 0 || echo 1)"
  check "${app}: build is a positive integer, not a 12-digit stamp (got '${bn}')" \
    "$(printf '%s' "$bn" | grep -Eq '^[1-9][0-9]*$' && echo 0 || echo 1)"
  check "${app}: build is not a copy of marketing (no more '1.0.N (1.0.N)')" \
    "$([[ "$bn" != "$mk" ]] && echo 0 || echo 1)"
  check "${app}: build strictly exceeds the sequence floor ${SECTION8_FLOOR} (got '${bn}')" \
    "$([[ "${bn:-0}" -gt "$SECTION8_FLOOR" ]] 2>/dev/null && echo 0 || echo 1)"
  check "${app}: build is at least the commit count (got '${bn}' vs ${COMMIT_COUNT})" \
    "$([[ "${bn:-0}" -ge "$COMMIT_COUNT" ]] 2>/dev/null && echo 0 || echo 1)"
  check "${app}: marketing and build describe one number (got '${mk}' / '${bn}')" \
    "$([[ "$mk" == "1.0.${bn}" ]] && echo 0 || echo 1)"
  check "${app}: reports the App Store Connect rendering" \
    "$(contains "will show this as: ${mk} (${bn})" && echo 0 || echo 1)"
done

# The guard: when the floor is already at or above the commit count, the build
# number is raised to floor + 1 and MARKETING moves with it, so the pair still
# describes one number. This is the case the one-commit fixture used to cover
# by accident; it gets its own loop now.
GUARD_FLOOR=$((COMMIT_COUNT + 3))
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" "$GUARD_FLOOR"
  run_ship "$app" --repo-root "$REPO" --allow-unverified-seq --dry-run
  line="$(printf '%s' "$OUT" | grep -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  mk="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  bn="$(printf '%s' "$line" | sed 's/^.* build=//')"

  check "${app}: guard raises the build to floor + 1 (got '${bn}')" \
    "$([[ "${bn:-0}" -eq "$((GUARD_FLOOR + 1))" ]] && echo 0 || echo 1)"
  check "${app}: guard moves marketing with the build (got '${mk}')" \
    "$([[ "$mk" == "1.0.${bn}" ]] && echo 0 || echo 1)"
  # Leave the fixture as the earlier sections found it:  the record is the only
  # floor source left, and the sections after this loop expect the plain
  # commit-count version.
  rm -f "${REPO}/$(project_rel "$app")/project.pbxproj"
  rmdir "${REPO}/$(project_rel "$app")" 2>/dev/null || true
done

# Regression guard (2026-10-19): the operator-override path must floor against
# the train the operator named, not against the configured default.  A
# --version 2.0.5 override has to read the 2.0 floor, or the auto-filled build
# number can collide with a 2.0.X build App Store Connect already holds and
# the upload is rejected as a duplicate.
check "the override path derives its floor from the shipped train" \
  "$(grep -q 'version_prefix "\$MARKETING"' "$SHIP" && echo 0 || echo 1)"
check "the override path does not floor against the default train" \
  "$(grep -q '_of_floor="\$(resolve_seq_floor "\$MARKETING_PREFIX"' "$SHIP" && echo 1 || echo 0)"
echo

# --- 9. The counter no longer decides the version -------------------------
echo "9. the counter stays put; the version comes from the commit count"
rm -f "$SEQ_FILE" "$SHIP_FILE"
printf '5' >"$SEQ_FILE"
seen=""
for i in 1 2 3; do
  run_ship congress --repo-root "$REPO" --allow-unverified-seq
  seen="${seen} $(seq_now)"
done
check "three allowed runs leave the counter at 5 (got:${seen})" \
  "$([[ "$seen" == " 5 5 5" ]] && echo 0 || echo 1)"
check "the run planned the commit-count version" \
  "$(contains "marketing=1.0.${COMMIT_COUNT}" && echo 0 || echo 1)"
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
check "3700s ago does not advance the counter" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 11. ASC unverified die-text names the real cause ------------------------
# The local build-seq counter is retired, so it is not a floor source and the
# die text must not blame it.  The cause is App Store Connect being
# unverifiable, and that alone is fatal.
echo "11. unverified ASC die-text names App Store Connect, not the local counter"
reset_state
run_ship congress --repo-root "$REPO"
check "exits 1 without --allow-unverified-seq" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "does not claim there is no local sequence" \
  "$(contains 'there is no local sequence' && echo 1 || echo 0)"
check "the retired local counter does not feed the floor" \
  "$(contains 'local=0' && echo 0 || echo 1)"
check "names App Store Connect as the cause" \
  "$(contains 'App Store Connect could not be' && echo 0 || echo 1)"
echo

echo "----------------------------------------"
echo "passed: ${PASS}   failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0

#!/usr/bin/env bash
# test-ship-seq.sh - Offline tests for ship-testflight.sh's version rules.
#
# Covers:
#   1. ORDERING: a run rejected by the ship gate must NOT resolve or consume
#      a version.  It used to: the gate was evaluated after the counter had
#      already been advanced, so a rate-limited attempt burned a version that
#      shipped nowhere (observed live: skipped at 4392s of a 9000s interval,
#      and the sequence still went 5 -> 6).
#   2. SCHEME (owner directive 2026-10-24, AFC-517): the marketing version is
#      the NEXT PATCH on the app's train (<prefix>.<P+1>, P from App Store
#      Connect), and the build number is INDEPENDENT of it:  the repo commit
#      count, raised above the App Store Connect floor.  The pair never reads
#      "1.0.N (N)" any more.
#   3. COUNTER: the local build-seq counter is retired.  Nothing writes it and
#      nothing reads it, so a leftover from an older scheme cannot push the
#      build number above the commit count it names.
#
# The App Store Connect answers come from a STUB `node` in FAKE_BIN:  it
# answers `asc-api.mjs latest-marketing-patch` with $FAKE_ASC_PATCH and
# `asc-api.mjs build-floor` with $FAKE_ASC_FLOOR (default 0), and exits 2 for
# anything else -- which is exactly what an unreachable App Store Connect
# looks like to the ship script.  Nothing here reaches the network.
#
# Everything runs offline against scratch state:
#   HOME                -> scratch (so no real home files exist and App Store
#                          Connect is never contacted; also makes it impossible
#                          for a test to touch the real ~/.cache/ios-fleet)
#   IOS_FLEET_STATE_DIR -> scratch last-ship file
#   PATH                -> a fake `xcodebuild` that refuses to archive and a
#                          fake `node` (passed as IOS_FLEET_NODE) that
#                          answers the ASC queries
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
# Sections 1-11 test the unchanged next-patch behaviour, so they run a copy of
# the fleet dir whose apps.json carries no fixed-version keys.  Section 12 tests
# the keys on their own copy.
LEGACY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-legacy.XXXXXX")"
cp -R "$SCRIPT_DIR/." "$LEGACY_DIR/"
python3 - "$LEGACY_DIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for a in d["apps"].values():
    a.pop("fixedMarketingVersion", None)
    a.pop("buildCountSeed", None)
    a.pop("macBundleId", None)
    a.pop("pairedBuildFeed", None)
json.dump(d, open(p, "w"), indent=2)
PY
SHIP="${LEGACY_DIR}/ship-testflight.sh"
[[ -f "$SHIP" ]] || { echo "missing $SHIP"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-seq-test.XXXXXX")"
trap 'rm -rf "$WORK" "$LEGACY_DIR"' EXIT

FAKE_HOME="${WORK}/home"
FAKE_BIN="${WORK}/bin"
STATE="${WORK}/state"
REPO="${WORK}/repo"
mkdir -p "$FAKE_HOME" "$FAKE_BIN" "$STATE" "$REPO" "${WORK}/tmp"

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

# A stub `node`:  answers the two App Store Connect version queries from the
# environment and exits 2 for everything else.  Exiting 2 is what the ship
# script sees when App Store Connect cannot be consulted, so a test can drive
# the unreachable-App-Store-Connect path without a network.
cat >"${FAKE_BIN}/node" <<'FAKE'
#!/usr/bin/env bash
cmd=""
for a in "$@"; do
  case "$a" in
    */asc-api.mjs) cmd="asc-api" ;;
    latest-marketing-patch|build-floor|released-store-version|next-shared-build)
      if [[ "$cmd" == "asc-api" ]]; then cmd="${cmd}:${a}"; fi
      ;;
  esac
done
case "$cmd" in
  asc-api:latest-marketing-patch)
    # No stubbed patch = App Store Connect cannot be consulted.
    # "auth" = App Store Connect rejected the key (asc-api exits 4).
    [[ "${FAKE_ASC_PATCH:-}" == "auth" ]] && exit 4
    [[ -n "${FAKE_ASC_PATCH:-}" ]] || exit 2
    printf '%s\n' "$FAKE_ASC_PATCH"
    exit 0
    ;;
  asc-api:released-store-version)
    [[ "${FAKE_RELEASED:-}" == "fail" ]] && exit 2
    printf '%s\n' "${FAKE_RELEASED:-}"
    exit 0
    ;;
  asc-api:next-shared-build)
    [[ "${FAKE_SHARED:-}" == "fail" ]] && exit 3
    [[ -n "${FAKE_SHARED:-}" ]] || exit 2
    printf '%s\n' "$FAKE_SHARED"
    exit 0
    ;;
  asc-api:build-floor)
    printf '%s\n' "${FAKE_ASC_FLOOR:-0}"
    exit 0
    ;;
esac
exit 2
FAKE
chmod +x "${FAKE_BIN}/node"

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
# Seed enough commits that the repo's commit count sits ABOVE the floor these
# tests use, so the normal path is exercised:  the build number is the commit
# count and the floor guard does not fire.  With a one-commit fixture the
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
# Owner directive 2026-10-24 (AFC-517): the build number starts from the commit
# count.  Read the count from the fixture instead of hard-coding it, so adding
# a seed commit to the harness cannot silently stale the assertions.
COMMIT_COUNT="$(git -C "$REPO" rev-list --count HEAD)"

SEQ_FILE="${STATE}/build-seq-congress.txt"
SHIP_FILE="${STATE}/last-ship-congress.txt"

# The App Store Connect answers the stub gives.  Unset = unreachable.
FAKE_ASC_PATCH=""
FAKE_ASC_FLOOR=""

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
    FLEET_SECRETS="${FAKE_BIN}/fleet-secrets" \
    ASC_KEY_ID=fake \
    IOS_FLEET_NODE="${FAKE_BIN}/node" \
    FAKE_ASC_PATCH="$FAKE_ASC_PATCH" \
    FAKE_ASC_FLOOR="$FAKE_ASC_FLOOR" \
    FAKE_RELEASED="${FAKE_RELEASED:-}" \
    FAKE_SHARED="${FAKE_SHARED:-}" \
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

# The planned pair, read out of the "marketing=<m> build=<b>" log line.
planned_pair() {
  local line
  line="$(printf '%s' "$OUT" | grep -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  PLANNED_MARKETING="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  PLANNED_BUILD="$(printf '%s' "$line" | sed 's/^.* build=//')"
}

reset_state() {
  rm -f "$SEQ_FILE" "$SHIP_FILE"
  printf '5' >"$SEQ_FILE"
}

# The paths below are the projectRel entries in this repo's
# scripts/ios-fleet/apps.json.  project.pbxproj is NOT a sequencing input any
# more (AFC-517):  the fixture exists so the run gets past the "project not
# found" check and reaches the version resolution.
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

echo "ship-testflight.sh version tests"
echo "state=${STATE}"
echo

# --- 1. Rate-limited run must not consume ----------------------------------
echo "1. ship gate: rate-limited run does not resolve a version"
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
  "$(contains 'version plan:' && echo 1 || echo 0)"
echo

# --- 2. Same-HEAD run must not consume -------------------------------------
echo "2. ship gate: already-shipped HEAD does not resolve a version"
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
  "$(contains "build=${COMMIT_COUNT}" && echo 0 || echo 1)"
check "an unverified patch plans the first patch of the train" \
  "$(contains 'marketing=1.0.1 build=' && echo 0 || echo 1)"
check "says loudly that the patch was unverified" \
  "$(contains 'UNVERIFIED' && echo 0 || echo 1)"
echo

# --- 4. --dry-run must not consume -----------------------------------------
echo "4. --dry-run does not ship anything"
reset_state
run_ship congress --repo-root "$REPO" --allow-unverified-seq --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "plans the build number without shipping it" \
  "$(contains "build=${COMMIT_COUNT}" && echo 0 || echo 1)"
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
echo "6. --upload-only does not resolve a version"
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

# --- 8. The version scheme (owner directive 2026-10-24, AFC-517) -----------
echo "8. version scheme: next patch on the train, independent build number"
FAKE_ASC_PATCH=236
FAKE_ASC_FLOOR=0
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  run_ship "$app" --repo-root "$REPO" --dry-run
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: the marketing version is the next patch on the train (got '${mk}')" \
    "$([[ "$mk" == "1.0.237" ]] && echo 0 || echo 1)"
  check "${app}: the build number is the repo commit count (got '${bn}')" \
    "$([[ "$bn" == "$COMMIT_COUNT" ]] && echo 0 || echo 1)"
  check "${app}: the build number is not the patch number (no '1.0.N (N)')" \
    "$([[ "$bn" != "237" ]] && echo 0 || echo 1)"
  check "${app}: the marketing version is not 1.0.<build> (got '${mk}' / '${bn}')" \
    "$([[ "$mk" != "1.0.${bn}" ]] && echo 0 || echo 1)"
  check "${app}: reports the App Store Connect rendering" \
    "$(contains "will show this as: ${mk} (${bn})" && echo 0 || echo 1)"
  check "${app}: prints the version plan line" \
    "$(contains 'version plan: asc_patch=236 -> marketing=1.0.237' && echo 0 || echo 1)"
  rm -f "${REPO}/$(project_rel "$app")/project.pbxproj"
  rmdir "${REPO}/$(project_rel "$app")" 2>/dev/null || true
done

# The floor above the commit count:  the build number moves to floor + 1 and
# the marketing version stays the next patch.  The two numbers are
# independent, so the floor never moves the version.
FLOOR_HIGH=202610180036
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_FLOOR="$FLOOR_HIGH"
  run_ship "$app" --repo-root "$REPO" --dry-run
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: a floor above the commit count raises the build to floor + 1 (got '${bn}')" \
    "$([[ "$bn" == "$((FLOOR_HIGH + 1))" ]] && echo 0 || echo 1)"
  check "${app}: the floor does not move the marketing version (got '${mk}')" \
    "$([[ "$mk" == "1.0.237" ]] && echo 0 || echo 1)"
  check "${app}: the marketing version is not 1.0.<build> (got '${mk}' / '${bn}')" \
    "$([[ "$mk" != "1.0.${bn}" ]] && echo 0 || echo 1)"
  rm -f "${REPO}/$(project_rel "$app")/project.pbxproj"
  rmdir "${REPO}/$(project_rel "$app")" 2>/dev/null || true
done
FAKE_ASC_FLOOR=0

# --version pins the marketing version exactly, and the build number is then
# floored against THAT train.
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_FLOOR=202610180036
  run_ship "$app" --repo-root "$REPO" --dry-run --version 1.0.236
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: --version is honoured exactly (got '${mk}')" \
    "$([[ "$mk" == "1.0.236" ]] && echo 0 || echo 1)"
  check "${app}: the build is floored against the pinned train (got '${bn}')" \
    "$([[ "$bn" == "202610180037" ]] && echo 0 || echo 1)"
  check "${app}: the marketing version is not 1.0.<build> (got '${mk}' / '${bn}')" \
    "$([[ "$mk" != "1.0.${bn}" ]] && echo 0 || echo 1)"
  rm -f "${REPO}/$(project_rel "$app")/project.pbxproj"
  rmdir "${REPO}/$(project_rel "$app")" 2>/dev/null || true
done
FAKE_ASC_FLOOR=0

# --build pins the build number exactly, and the marketing version is still
# the automatic next patch.
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  run_ship "$app" --repo-root "$REPO" --dry-run --build 999
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: --build is honoured exactly (got '${bn}')" \
    "$([[ "$bn" == "999" ]] && echo 0 || echo 1)"
  check "${app}: --build does not move the marketing version (got '${mk}')" \
    "$([[ "$mk" == "1.0.237" ]] && echo 0 || echo 1)"
  rm -f "${REPO}/$(project_rel "$app")/project.pbxproj"
  rmdir "${REPO}/$(project_rel "$app")" 2>/dev/null || true
done

# Without --allow-unverified-seq, an unreachable App Store Connect is fatal:
# the marketing version and the build floor both come from it.
for app in socratic congress usage usage-local; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_PATCH=""
  run_ship "$app" --repo-root "$REPO" --dry-run
  check "${app}: an unreachable App Store Connect fails the run (rc=${RC})" \
    "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
  check "${app}: says what could not be determined" \
    "$(contains 'cannot determine the next marketing version' && echo 0 || echo 1)"
  check "${app}: does not ship a version it could not verify" \
    "$(contains 'marketing=1.0.' && echo 1 || echo 0)"
  rm -f "${REPO}/$(project_rel "$app")/project.pbxproj"
  rmdir "${REPO}/$(project_rel "$app")" 2>/dev/null || true
done
FAKE_ASC_PATCH=236
echo

# --- 9. The counter no longer decides the version -------------------------
echo "9. the counter stays put; the version comes from App Store Connect"
rm -f "$SEQ_FILE" "$SHIP_FILE"
printf '5' >"$SEQ_FILE"
seen=""
for i in 1 2 3; do
  run_ship congress --repo-root "$REPO" --dry-run
  seen="${seen} $(seq_now)"
done
check "three allowed runs leave the counter at 5 (got:${seen})" \
  "$([[ "$seen" == " 5 5 5" ]] && echo 0 || echo 1)"
check "the run planned the next patch on the train" \
  "$(contains 'marketing=1.0.237' && echo 0 || echo 1)"
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
# An empty stubbed patch is exactly what an unreachable App Store Connect
# looks like to the ship script.
FAKE_ASC_PATCH=""
run_ship congress --repo-root "$REPO"
check "exits 1 without --allow-unverified-seq" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "does not claim there is no local sequence" \
  "$(contains 'there is no local sequence' && echo 1 || echo 0)"
check "the retired local counter does not feed the floor" \
  "$(contains 'local=0' && echo 1 || echo 0)"
check "names the marketing version as what could not be determined" \
  "$(contains 'cannot determine the next marketing version' && echo 0 || echo 1)"
check "names App Store Connect as the cause" \
  "$(contains 'App Store Connect could not be' && echo 0 || echo 1)"
FAKE_ASC_PATCH=236
echo

# --- rejected API key -----------------------------------------------------
# A 401/403 from App Store Connect is not "unreachable":  even
# --allow-unverified-seq must not plan a version around a key Apple rejects.
echo "rejected API key: fatal even with --allow-unverified-seq"
reset_state 2>/dev/null || true
FAKE_ASC_PATCH=auth
run_ship congress --repo-root "$REPO" --allow-unverified-seq --dry-run
check "a rejected key fails the run (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "says the key was rejected" "$(contains 'rejected the API key' && echo 0 || echo 1)"
check "plans no version around it" "$(contains 'UNVERIFIED patch' && echo 1 || echo 0)"
FAKE_ASC_PATCH=236
echo

echo "12. fixed marketing version + shared four-digit build (apps.json fixedMarketingVersion)"
FIXDIR="${WORK}/fleet-fixed"
rm -rf "$FIXDIR"; cp -R "$SCRIPT_DIR" "$FIXDIR"
python3 - "$FIXDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
a = d["apps"]
for k in list(a)[:1]:
    a[k]["fixedMarketingVersion"] = "1.1.2"
    a[k].pop("buildCountSeed", None)
    a[k].pop("macBundleId", None)
    a[k].pop("pairedBuildFeed", None)
json.dump(d, open(p, "w"), indent=2)
PY
FIXAPP="$(python3 -c 'import json,sys; print(list(json.load(open(sys.argv[1]))["apps"])[0])' "$FIXDIR/apps.json")"
SHIP_REAL="$SHIP"; SHIP="${FIXDIR}/ship-testflight.sh"
rm -f "${STATE}/build-seq-${FIXAPP}.txt" "${STATE}/last-ship-${FIXAPP}.txt"
write_record "$FIXAPP" 5
FAKE_ASC_PATCH=239; FAKE_ASC_FLOOR=2383; FAKE_RELEASED=""; FAKE_SHARED="1000"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
planned_pair
check "fixed: marketing stays 1.1.2 even though ASC holds patch 239 (got '${PLANNED_MARKETING}')" \
  "$([[ "$PLANNED_MARKETING" == "1.1.2" ]] && echo 0 || echo 1)"
check "fixed: an empty inventory plans the first shared four-digit build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "1000" ]] && echo 0 || echo 1)"
check "fixed: the integer floor and commit count play no part" \
  "$(contains 'shared four-digit build 1000 for fixed version 1.1.2' && echo 0 || echo 1)"
FAKE_SHARED="1001"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
planned_pair
check "fixed: a counter holding 1000 goes to 1001 (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "1001" ]] && echo 0 || echo 1)"
FAKE_SHARED="fail"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: an unreadable or exhausted inventory stops the run, nothing guessed" \
  "$(contains 'cannot work out the next shared four-digit build' && echo 0 || echo 1)"
FAKE_SHARED=""
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: an unreadable inventory stops the run" \
  "$(contains 'cannot work out the next shared four-digit build' && echo 0 || echo 1)"
FAKE_SHARED="1000"; FAKE_RELEASED="1.1.2"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: a version at the released App Store version is refused, not bumped" \
  "$(contains 'at or below the released App Store version 1.1.2' && echo 0 || echo 1)"
FAKE_RELEASED="fail"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: an unreadable released App Store version stops the run (fail closed)" \
  "$(contains 'cannot read the released App Store version' && echo 0 || echo 1)"
FAKE_SHARED="1000"; FAKE_RELEASED=""
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run --build 7
check "fixed: a non-four-digit --build is refused" \
  "$(contains 'fixed mode requires a four-digit build 1000..9999' && echo 0 || echo 1)"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run --build 999
check "fixed: a three-digit --build is refused" \
  "$(contains 'fixed mode requires a four-digit build 1000..9999' && echo 0 || echo 1)"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run --build 1000
planned_pair
check "fixed: a four-digit --build at the minimum is honoured (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "1000" ]] && echo 0 || echo 1)"
FAKE_SHARED="1001"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run --build 1000
check "fixed: a four-digit --build below the minimum is refused" \
  "$(contains 'requested build is below the planned four-digit minimum 1001' && echo 0 || echo 1)"
FAKE_SHARED="1000"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run --version 1.1.2
planned_pair
check "fixed: --version equal to the fixed version stays in fixed mode (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "1000" ]] && echo 0 || echo 1)"
python3 - "$FIXDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["apps"]["fixmac"] = {
  "displayName": "Fixed Mac",
  "fixedMarketingVersion": "1.1.2",
  "bundleId": "trade.example.fixmac",
  "scheme": "FixMac",
  "projectRel": "mac/FixMac.xcodeproj",
  "platform": "macOS",
  "marketingVersionDefault": "1.0.0"
}
json.dump(d, open(p, "w"), indent=2)
PY
FAKE_SHARED="1000"; FAKE_RELEASED=""
rm -f "${STATE}/build-seq-fixmac.txt" "${STATE}/last-ship-fixmac.txt"
run_ship "fixmac" --repo-root "$REPO" --dry-run
planned_pair
check "fixed macOS: marketing stays 1.1.2 (got '${PLANNED_MARKETING}')" \
  "$([[ "$PLANNED_MARKETING" == "1.1.2" ]] && echo 0 || echo 1)"
check "fixed macOS: plans the shared four-digit build instead of refusing (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "1000" ]] && echo 0 || echo 1)"
check "fixed macOS: logs the shared counter line" \
  "$(contains 'shared four-digit build 1000 for fixed version 1.1.2' && echo 0 || echo 1)"
SHIP="$SHIP_REAL"; FAKE_ASC_FLOOR=0; FAKE_RELEASED=""; FAKE_SHARED=""; FAKE_ASC_PATCH=236
echo

echo "----------------------------------------"
echo "passed: ${PASS}   failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0

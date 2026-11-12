#!/usr/bin/env bash
# test-ios-scheduled-ship-gate.sh - Offline tests for ios-scheduled-ship-gate.sh.
#
# The gate is the only thing standing between a half-hourly cron and a
# TestFlight build for every backend commit. It runs exclusively on the owned
# Mac runner, so without these tests a defect in it is invisible until either
# testers get spammed or an iOS change silently never ships. Everything here is
# a throwaway git repo in a scratch dir: no network, no credentials, no
# xcodebuild, no App Store Connect.
#
# Usage: bash scripts/test-ios-scheduled-ship-gate.sh
#
# ASCII-only (Apple bash 3.2 safe).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="${SCRIPT_DIR}/ios-scheduled-ship-gate.sh"
[[ -f "$GATE" ]] || { echo "missing $GATE"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ship-gate-test.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

REPO="${TMP}/repo"
STATE="${TMP}/state"
mkdir -p "$REPO" "$STATE"

git -C "$REPO" init --quiet -b main
git -C "$REPO" config user.email "test@example.invalid"
git -C "$REPO" config user.name "gate test"

commit() {
  # commit <path> <content> <message>
  mkdir -p "$(dirname "${REPO}/$1")"
  printf '%s\n' "$2" >"${REPO}/$1"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "$3"
  git -C "$REPO" rev-parse HEAD
}

PASS=0
FAIL=0
check() {
  # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  ok  : $1 (=$3)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

run_gate() {
  # run_gate <event> [extra args...] -> prints "key=value" lines
  # Single --path-prefix: the original call shape, which must keep working.
  local event="$1"; shift
  bash "$GATE" \
    --event "$event" \
    --path-prefix "ios/" \
    --repo-root "$REPO" \
    --state-dir "$STATE" \
    "$@" 2>&1
}

run_gate_paths() {
  # run_gate_paths <event> [extra args...] -> prints "key=value" lines
  # Full push-path set, mirroring .github/workflows/ios-ship.yml on.push.paths
  # entry-for-entry (same strings, same order): the scheduled backstop must
  # ship exactly what the push trigger would have shipped.
  local event="$1"; shift
  bash "$GATE" \
    --event "$event" \
    --path-prefix "ios/**" \
    --path-prefix ".github/workflows/ios-ship.yml" \
    --path-prefix "scripts/ios-ship-testflight.sh" \
    --path-prefix "scripts/ios-appstore-gm-prepare.sh" \
    --path-prefix "scripts/ios-asc-key-env.sh" \
    --path-prefix "scripts/ios-stage-asc-key.sh" \
    --path-prefix "scripts/ios-install-appstore-profiles.sh" \
    --path-prefix "scripts/ios-collect-ship-logs.sh" \
    --path-prefix "scripts/ios-fleet/**" \
    --path-prefix "scripts/ios-fleet-pin.sh" \
    --path-prefix "scripts/ios-fleet.sha256" \
    --repo-root "$REPO" \
    --state-dir "$STATE" \
    "$@" 2>&1
}

run_gate_excl() {
  # run_gate_excl <event> [extra args...] -> prints "key=value" lines
  # Subtree plus a '!' carve-out, proving exclusions work push-style.
  local event="$1"; shift
  bash "$GATE" \
    --event "$event" \
    --path-prefix "ios/**" \
    --path-prefix "!ios/generated/**" \
    --repo-root "$REPO" \
    --state-dir "$STATE" \
    "$@" 2>&1
}

field() {
  # field <output> <key>
  printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k {print $2}' | tail -1
}

set_state() {
  # set_state <app> <sha>
  printf '%s %s\n' "$(date +%s)" "$2" >"${STATE}/last-ship-$1.txt"
}

echo "== syntax =="
bash -n "$GATE" && echo "  ok  : ios-scheduled-ship-gate.sh parses"

echo "== fixture =="
BASE="$(commit README.md base "base")"
echo "  base commit ${BASE:0:10}"

echo "== 1. push/dispatch events bypass the gate entirely =="
out="$(run_gate push demo)"
check "push -> should_ship" 1 "$(field "$out" should_ship)"
out="$(run_gate workflow_dispatch demo)"
check "workflow_dispatch -> should_ship" 1 "$(field "$out" should_ship)"

echo "== 2. scheduled tick with no ship history defers to the ship script =="
out="$(run_gate schedule demo)"
check "no state -> should_ship" 1 "$(field "$out" should_ship)"

echo "== 3. scheduled tick on an already-shipped HEAD skips =="
set_state demo "$BASE"
out="$(run_gate schedule demo)"
check "HEAD already shipped -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 4. backend-only commits since the last ship do NOT ship =="
commit "server/api.ts" "backend change" "feat(server): unrelated to iOS" >/dev/null
commit "docs/notes.md" "docs" "docs: nothing an iOS tester can see" >/dev/null
out="$(run_gate schedule demo)"
check "backend-only -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 5. an iOS change since the last ship DOES ship =="
commit "ios/App/View.swift" "// ui" "fix(ios): visible change" >/dev/null
out="$(run_gate schedule demo)"
check "ios change -> should_ship" 1 "$(field "$out" should_ship)"

echo "== 6. per-app outputs are independent =="
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
set_state demo "$HEAD_SHA"          # caught up
set_state demo-local "$BASE"        # behind, and iOS changed since BASE
out="$(run_gate schedule demo demo-local)"
check "caught-up app" 0 "$(field "$out" ship_demo)"
check "behind app" 1 "$(field "$out" ship_demo_local)"
check "any-app roll-up" 1 "$(field "$out" should_ship)"

echo "== 7. an unreachable last-ship sha falls back to the recorded timestamp =="
# Observed live on Usage-Monitor 2026-08-13: the recorded ship sha was the tip
# of a grok/* ship worktree, not an ancestor of main. The same is possible here
# any time a ship runs from an agent lane. Skipping forever would make the
# backstop useless; shipping blind would spam TestFlight.
rm -f "${STATE}/last-ship-demo-local.txt"
FUTURE=$(( $(date +%s) + 600 ))
printf '%s %s\n' "$FUTURE" "0000000000000000000000000000000000000000" >"${STATE}/last-ship-demo.txt"
out="$(run_gate schedule demo)"
check "unreachable sha, no newer iOS commits -> should_ship" 0 "$(field "$out" should_ship)"

PAST=$(( $(date +%s) - 86400 ))
printf '%s %s\n' "$PAST" "0000000000000000000000000000000000000000" >"${STATE}/last-ship-demo.txt"
out="$(run_gate schedule demo)"
check "unreachable sha, iOS commits since -> should_ship" 1 "$(field "$out" should_ship)"

printf 'not-a-timestamp deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' >"${STATE}/last-ship-demo.txt"
out="$(run_gate schedule demo)"
check "unreachable sha, unusable ts -> defers to ship script" 1 "$(field "$out" should_ship)"

# Back to a clean skip state for the exit-code assertion below.
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 8. deciding 'skip' is never an error exit =="
run_gate schedule demo >/dev/null
check "exit code on skip" 0 "$?"

echo "== 9. full push-path set: tooling-only merge ships, unrelated-only skips =="
# The missed-push backstop: a merge touching only ship tooling must ship on
# the next tick, while README/server-only ticks must stay quiet.
commit "scripts/ios-fleet/ship-testflight.sh" "# fleet tooling" "chore(ios): fleet tooling only" >/dev/null
out="$(run_gate_paths schedule demo)"
check "tooling-only (scripts/ios-fleet/) -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"
commit "README.md" "readme tweak" "docs: readme only" >/dev/null
commit "src/server/api.ts" "backend" "feat(server): backend only" >/dev/null
out="$(run_gate_paths schedule demo)"
check "unrelated-only (README + server) -> should_ship" 0 "$(field "$out" should_ship)"

echo "== 10. workflow-file and project-file merges ship under the full set =="
commit ".github/workflows/ios-ship.yml" "# ship workflow" "ci(ios): workflow only" >/dev/null
out="$(run_gate_paths schedule demo)"
check "workflow-file-only -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"
commit "ios/project.yml" "# project" "chore(ios): project file" >/dev/null
out="$(run_gate_paths schedule demo)"
check "ios/project.yml -> should_ship" 1 "$(field "$out" should_ship)"
set_state demo "$(git -C "$REPO" rev-parse HEAD)"

echo "== 11. '!' exclusions carve out of a matching subtree =="
commit "ios/generated/strings.swift" "// generated" "chore(ios): generated only" >/dev/null
out="$(run_gate_excl schedule demo)"
check "excluded-subtree-only -> should_ship" 0 "$(field "$out" should_ship)"
commit "ios/App/Real.swift" "// real" "fix(ios): real change" >/dev/null
out="$(run_gate_excl schedule demo)"
check "real ios change alongside excluded -> should_ship" 1 "$(field "$out" should_ship)"

echo
echo "passed=${PASS} failed=${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
echo "scheduled-ship-gate: all tests passed"

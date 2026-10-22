#!/usr/bin/env bash
# ios-fleet-pin.sh - verify (or refresh) the checksum pin for the in-repo iOS
# ship tooling this repo vendors under scripts/ios-fleet/.
#
# Usage:
#   bash scripts/ios-fleet-pin.sh            # verify; exit 1 on drift
#   bash scripts/ios-fleet-pin.sh --check    # same
#   bash scripts/ios-fleet-pin.sh --update   # rewrite the pin from the in-repo copy
#
# WHY THIS EXISTS
#   GitHub-hosted macos-latest has no /Users/jay/apps/ios-fleet. This repo
#   vendors the fleet scripts (Congress.Trade protocol) and pins their sha256
#   so an unreviewed edit to ship-testflight.sh / apps.json / asc-api.mjs
#   cannot silently change what TestFlight uploads. Refreshing the pin is a
#   reviewed 3-line PR.
#
# ON DRIFT
#   Read the diff, decide whether the tooling change is wanted, then either
#   revert the fleet files or run --update and land the new pin in a PR.
#   Emergency bypass for a single ship: IOS_FLEET_PIN_SKIP=1.
#
# ASCII-only (Apple bash 3.2 safe).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_DIR="${IOS_FLEET_DIR:-${REPO_ROOT}/scripts/ios-fleet}"
PIN_FILE="${REPO_ROOT}/scripts/ios-fleet.sha256"

# Exactly the runtime files that can change what this repo ships.
PINNED_FILES="ship-testflight.sh asc-api.mjs asc-key.mjs apps.json AppUpdatePrompt.swift"

MODE="check"
case "${1:-}" in
  --update) MODE="update" ;;
  --check|"") MODE="check" ;;
  *) echo "usage: $0 [--check|--update]" >&2; exit 2 ;;
esac

hash_one() {
  # "<sha256>  <name>" for one file, name-only so the pin is path-independent.
  local f="$1"
  [[ -f "${FLEET_DIR}/${f}" ]] || { echo "error: missing ${FLEET_DIR}/${f}" >&2; return 1; }
  if command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "$(shasum -a 256 "${FLEET_DIR}/${f}" | awk '{print $1}')" "$f"
  else
    printf '%s  %s\n' "$(sha256sum "${FLEET_DIR}/${f}" | awk '{print $1}')" "$f"
  fi
}

compute_all() {
  local f
  for f in $PINNED_FILES; do
    hash_one "$f" || return 1
  done
}

if [[ "$MODE" == "update" ]]; then
  {
    echo "# sha256 pin for the in-repo iOS ship tooling in scripts/ios-fleet."
    echo "# GitHub-hosted macos-latest ships from this copy, not /Users/jay/apps/ios-fleet."
    echo "# Refresh with: bash scripts/ios-fleet-pin.sh --update  (then land it in a PR)"
    compute_all
  } >"$PIN_FILE"
  echo "[ios-fleet-pin] wrote ${PIN_FILE}"
  exit 0
fi

if [[ -n "${IOS_FLEET_PIN_SKIP:-}" ]]; then
  echo "[ios-fleet-pin] IOS_FLEET_PIN_SKIP set - skipping the drift check for this run"
  exit 0
fi

if [[ ! -f "$PIN_FILE" ]]; then
  echo "error: pin file missing: ${PIN_FILE}" >&2
  echo "       create it with: bash scripts/ios-fleet-pin.sh --update" >&2
  exit 1
fi

EXPECTED="$(grep -v '^#' "$PIN_FILE" | sed '/^$/d')"
ACTUAL="$(compute_all)" || exit 1

if [[ "$EXPECTED" == "$ACTUAL" ]]; then
  echo "[ios-fleet-pin] OK - ${FLEET_DIR} matches scripts/ios-fleet.sha256"
  exit 0
fi

echo "error: in-repo iOS ship tooling has drifted from this repo's pin." >&2
echo "  fleet dir: ${FLEET_DIR}" >&2
echo "  pin file:  scripts/ios-fleet.sha256" >&2
echo "" >&2
echo "  expected:" >&2
printf '%s\n' "$EXPECTED" | sed 's/^/    /' >&2
echo "  actual:" >&2
printf '%s\n' "$ACTUAL" | sed 's/^/    /' >&2
echo "" >&2
echo "  Review the change, then either revert it or accept it with:" >&2
echo "    bash scripts/ios-fleet-pin.sh --update && git commit -am 'chore(ios): refresh ios-fleet pin'" >&2
echo "  Emergency single-ship bypass: IOS_FLEET_PIN_SKIP=1" >&2
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::error::ios-fleet tooling drifted from scripts/ios-fleet.sha256 - review and refresh the pin"
fi
exit 1

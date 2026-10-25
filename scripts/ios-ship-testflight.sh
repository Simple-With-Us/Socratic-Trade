#!/usr/bin/env bash
# Thin wrapper: ship this app's native iOS binary to TestFlight (no Xcode UI).
# Canonical implementation: scripts/ios-fleet/ship-testflight.sh (in this repo).
# The host copy at /Users/jay/apps/ios-fleet/ is a runtime install of the same
# file and is used ONLY as a fallback when the in-repo copy is missing.
#
# Do not run this on Linux cloud seats. Archive + upload is
# .github/workflows/ios-ship.yml on GitHub-hosted macos-latest (owner 2026-08-24).
# Do not restart the retired self-hosted Mac runner or local Xcode to ship.
#
# WHY A MERGE OFTEN DOES NOT PRODUCE A TESTFLIGHT BUILD
# .github/workflows/ios-ship.yml calls this on every push to main touching
# ios/**, but the fleet script enforces a minimum interval between
# successful ships per app: DEFAULT_MIN_INTERVAL_SEC=3600 (3600s = 1 hour),
# defined near the top of scripts/ios-fleet/ship-testflight.sh. Runs inside that
# window log "ship-gate: skip" and exit 0. It also skips when git HEAD already
# shipped. Neither kind of skip resolves a version (fixed 2026-08-12).
# Override one run with IOS_TF_MIN_INTERVAL_SEC=<seconds> or --force-ship;
# changing the standing limit means editing DEFAULT_MIN_INTERVAL_SEC.
#
# VERSION NUMBERS (owner directive 2026-10-24, AFC-517): MARKETING_VERSION is
# the NEXT PATCH on the app's train (<prefix>.<P+1>, P from App Store Connect)
# and CURRENT_PROJECT_VERSION is the repo commit count, raised above the App
# Store Connect floor.  The two numbers are independent, so App Store Connect
# shows e.g. "1.0.237 (2360)" -- not "1.0.N (N)".
#
# STABLE XCODE IS MANDATORY (owner, reaffirmed 2026-08-11).
# Xcode-beta's SDK breaks TestFlight / App Store Connect compatibility: a binary
# built against a beta SDK is accepted into TestFlight but rejected at
# submission as INVALID_BINARY.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

STABLE_XCODE="${STABLE_XCODE:-/Applications/Xcode.app}"
STABLE_DEV_DIR="${STABLE_XCODE}/Contents/Developer"

# What would we build with if we did nothing?
resolved="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"

is_beta() {
  local dir="$1"
  [[ "$dir" == *Xcode-beta* ]] && return 0
  # Also catch a stable-looking path whose Xcode self-reports as a beta.
  local plist="${dir%/Contents/Developer}/Contents/Info.plist"
  if [[ -r "$plist" ]]; then
    local ver
    ver=$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || echo "")
    [[ "$ver" == *[Bb]eta* ]] && return 0
  fi
  return 1
}

if [[ -z "$resolved" ]] || is_beta "$resolved"; then
  if [[ ! -d "$STABLE_DEV_DIR" ]]; then
    echo "ERROR: stable Xcode not found at ${STABLE_XCODE}." >&2
    echo "       Refusing to build for App Store Connect with Xcode-beta --" >&2
    echo "       beta-SDK binaries are rejected as INVALID_BINARY at submission." >&2
    echo "       This wrapper is for GitHub-hosted macos-latest (ios-ship.yml)." >&2
    echo "       Do not run xcodebuild locally or restart a Mac runner." >&2
    exit 1
  fi
  [[ -n "$resolved" ]] && echo "[ios-ship] refusing beta toolchain at ${resolved}"
  export DEVELOPER_DIR="$STABLE_DEV_DIR"
else
  export DEVELOPER_DIR="$resolved"
fi

# Fail loudly rather than silently shipping a beta-built binary.
if is_beta "$DEVELOPER_DIR"; then
  echo "ERROR: DEVELOPER_DIR still resolves to a beta Xcode (${DEVELOPER_DIR})." >&2
  exit 1
fi

echo "[ios-ship] DEVELOPER_DIR=${DEVELOPER_DIR}"
xcodebuild -version | sed 's/^/[ios-ship] /'

# Prefer the reviewed, version-controlled copy. Fall back to the host install
# only if it is absent, and say so loudly -- a silent fallback would put an
# unreviewed script back in charge of release numbering, which is the exact
# failure this vendoring was meant to end.
IN_REPO="${ROOT}/scripts/ios-fleet/ship-testflight.sh"
HOST_COPY="/Users/jay/apps/ios-fleet/ship-testflight.sh"

if [[ -f "$IN_REPO" ]]; then
  SHIP_SCRIPT="$IN_REPO"
  echo "[ios-ship] using in-repo fleet script: ${SHIP_SCRIPT}"
elif [[ -f "$HOST_COPY" ]]; then
  SHIP_SCRIPT="$HOST_COPY"
  echo "[ios-ship] ===================================================================" >&2
  echo "[ios-ship] WARNING: in-repo fleet script missing (${IN_REPO})." >&2
  echo "[ios-ship] WARNING: falling back to the UNVERSIONED host copy at" >&2
  echo "[ios-ship] WARNING:   ${HOST_COPY}" >&2
  echo "[ios-ship] WARNING: that copy is outside git -- no history, no review. It may" >&2
  echo "[ios-ship] WARNING: number this release differently than the repo would." >&2
  echo "[ios-ship] WARNING: Restore scripts/ios-fleet/ before relying on this build." >&2
  echo "[ios-ship] ===================================================================" >&2
else
  echo "ERROR: no fleet ship script found." >&2
  echo "       looked for: ${IN_REPO}" >&2
  echo "                   ${HOST_COPY}" >&2
  echo "       Hosted macos-latest has no /Users/jay/apps/ios-fleet; vendor it." >&2
  exit 1
fi

exec bash "$SHIP_SCRIPT" socratic --repo-root "$ROOT" "$@"

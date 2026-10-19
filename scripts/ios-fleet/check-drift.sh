#!/usr/bin/env bash
# check-drift.sh - Compare this repo's ios-fleet ship-tooling copies against
# the runtime install location (/Users/jay/apps/ios-fleet/) by sha256.
#
# Usage:
#   bash scripts/ios-fleet/check-drift.sh
#
# Exit codes:
#   0  in sync (or runtime dir absent, e.g. CI / a machine other than the
#      owner's Mac) — prints a warning in the absent case, does not fail.
#   1  one or more files differ between the repo copy and the runtime copy.
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="${IOS_FLEET_RUNTIME_DIR:-$HOME/apps/ios-fleet}"

FILES=(
  "ship-testflight.sh"
  "ship-all.sh"
  "apps.json"
  "asc-api.mjs"
  "ExportOptions-appstore.plist"
  "ExportOptions-export-ipa.plist"
  "AppUpdatePrompt.swift"
)

if [[ ! -d "$RUNTIME_DIR" ]]; then
  echo "[check-drift] warning: runtime dir not found ($RUNTIME_DIR); skipping drift check"
  exit 0
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

DRIFTED=0
for f in "${FILES[@]}"; do
  repo_file="${SCRIPT_DIR}/${f}"
  runtime_file="${RUNTIME_DIR}/${f}"

  if [[ ! -f "$repo_file" ]]; then
    echo "[check-drift] error: missing repo file: $repo_file"
    DRIFTED=1
    continue
  fi
  if [[ ! -f "$runtime_file" ]]; then
    echo "[check-drift] warning: missing runtime file: $runtime_file (skipping)"
    continue
  fi

  repo_hash="$(sha256_of "$repo_file")"
  runtime_hash="$(sha256_of "$runtime_file")"
  if [[ "$repo_hash" != "$runtime_hash" ]]; then
    echo "[check-drift] DRIFT: $f differs (repo=$repo_hash runtime=$runtime_hash)"
    DRIFTED=1
  else
    echo "[check-drift] ok: $f matches"
  fi
done

if [[ "$DRIFTED" -ne 0 ]]; then
  echo "[check-drift] FAIL: repo and runtime copies are out of sync; re-run the install commands in README.md"
  exit 1
fi

echo "[check-drift] IN SYNC: repo and runtime ios-fleet tooling match"
exit 0

#!/usr/bin/env bash
# Proposed launchd wrapper. Install only after reviewed guard+adapter+token canary.
# No gh-auth fallback, no raw relay credential on disk. Native platform bootstrap only.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
INFISICAL_TOKEN="$(/usr/bin/security find-generic-password -s com.jay.wise-st-relay -a INFISICAL_TOKEN -w /Library/Keychains/System.keychain 2>/dev/null)" || {
  echo 'Wise ST Keychain service token unavailable; refusing personal fallback' >&2
  exit 1
}
export INFISICAL_TOKEN
exec python3 "$HOME/.claude-merge-shepherd/wise-relay-exec.py" -- bash "$HOME/.claude-merge-shepherd/merge-shepherd.sh"

#!/usr/bin/env bash
# Prepare a GitHub-hosted macos-26 runner to archive for App Store review.
# Writes ASC credentials and imports the iOS Distribution identity.
# Never prints secret values.  Fail closed on a beta macOS host.
set +o xtrace
set -euo pipefail
umask 077

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[ios-gm] $*"; }

os=$(sw_vers -productVersion)
build=$(sw_vers -buildVersion)
log "macOS ${os} (${build})"
# Apple seed trains stamp a lowercase letter after the build number
# (26A5406e).  GM builds end in digits (25F84, 24G720).
if echo "$build" | grep -Eq '[0-9][a-z]$'; then
  die "beta macOS host ${os} (${build}).  App Store review rejects these as INVALID_BINARY.  Use GitHub-hosted macos-26 (Tahoe GM)."
fi

: "${ASC_KEY_ID:?ASC_KEY_ID required}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID required}"
# Current CI passes ASC_KEY_PATH; retain ASC_KEY_P8 for local legacy callers.
if [[ -z "${ASC_KEY_PATH:-}" ]]; then
  : "${ASC_KEY_P8:?ASC_KEY_P8 or ASC_KEY_PATH required}"
fi
: "${IOS_DIST_P12_BASE64:?IOS_DIST_P12_BASE64 required}"
: "${IOS_DIST_P12_PASSWORD:?IOS_DIST_P12_PASSWORD required}"

SECRETS_DIR="${HOME}/.secrets"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

KEY_PATH="${ASC_KEY_PATH:-${SECRETS_DIR}/AuthKey.p8}"
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  [[ -s "$KEY_PATH" ]] || die "ASC_KEY_PATH has no key file"
else
  # Legacy local path: CI stages the key file before this helper runs.
  printf '%s\n' "$ASC_KEY_P8" > "$KEY_PATH"
fi
chmod 600 "$KEY_PATH"

ENV_PATH="${SECRETS_DIR}/appstore-connect.env"
{
  printf 'ASC_KEY_ID=%s\n' "$ASC_KEY_ID"
  printf 'ASC_ISSUER_ID=%s\n' "$ASC_ISSUER_ID"
  printf 'ASC_KEY_PATH=%s\n' "$KEY_PATH"
} > "$ENV_PATH"
chmod 600 "$ENV_PATH"

P12_PATH="${SECRETS_DIR}/ios-distribution.p12"
printf '%s' "$IOS_DIST_P12_BASE64" | base64 --decode > "$P12_PATH"
chmod 600 "$P12_PATH"

KC_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KC_PATH="${KC_DIR}/app-signing.keychain-db"
KC_PASS_FILE="${KC_DIR}/app-signing-kc-pass"
openssl rand -base64 24 > "$KC_PASS_FILE"
chmod 600 "$KC_PASS_FILE"
KC_PASS=$(cat "$KC_PASS_FILE")

security delete-keychain "$KC_PATH" >/dev/null 2>&1 || true
security create-keychain -p "$KC_PASS" "$KC_PATH"
security set-keychain-settings -lut 21600 "$KC_PATH"
security unlock-keychain -p "$KC_PASS" "$KC_PATH"
security import "$P12_PATH" -k "$KC_PATH" -P "$IOS_DIST_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/xcodebuild >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PASS" "$KC_PATH" >/dev/null
security list-keychain -d user -s "$KC_PATH" login.keychain-db

# Identity names only -- never dump the p12.
if ! security find-identity -v -p codesigning "$KC_PATH" | grep -q 'Apple Distribution'; then
  die "imported keychain has no Apple Distribution identity"
fi
log "Apple Distribution identity imported"
log "ASC env written (key id length ${#ASC_KEY_ID})"

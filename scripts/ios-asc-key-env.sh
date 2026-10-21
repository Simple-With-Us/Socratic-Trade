#!/usr/bin/env bash
# Hand the App Store Connect private key to a child process in the environment.
#
# The key is a secret, and the approved sources are the process environment, a
# captured `fleet-secrets get` and bootstrap-only Keychain credentials.  A path
# on disk is not one of them (AFC-459, revision 2), so the client takes the key
# from the environment and never reads a key file.
#
# In the hosted job the key cannot cross a step boundary, because the only
# channel between steps is the environment file, and this repository's
# invariant is that no key material lands in it (scripts/test-ios-stage-asc-key.sh).
# So the step that calls the client fetches the key here and hands it to the
# child in the child's environment.
#
# Usage:
#   bash scripts/ios-asc-key-env.sh <command> [args...]
#
# The key never reaches stdout, argv, a log line or a file:  it is exported
# into the child's environment, and this process is replaced by the child.
set +o xtrace
set -euo pipefail
export INFISICAL_DISABLE_UPDATE_CHECK=true

if [[ $# -lt 1 ]]; then
  echo "usage: ios-asc-key-env.sh <command> [args...]" >&2
  exit 2
fi

if ! command -v infisical >/dev/null 2>&1; then
  echo "::error::Infisical CLI is not installed." >&2
  exit 1
fi
if [[ -z "${INFISICAL_PROJECT_ID:-}" ]]; then
  echo "::error::Missing INFISICAL_PROJECT_ID." >&2
  exit 1
fi

client_id="${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-${INFISICAL_CLIENT_ID:-}}"
client_secret="${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-${INFISICAL_CLIENT_SECRET:-}}"
if [[ -z "$client_id" || -z "$client_secret" ]]; then
  echo "::error::Missing Infisical machine identity." >&2
  exit 1
fi

token="$(
  env -u INFISICAL_CLIENT_ID -u INFISICAL_CLIENT_SECRET -u INFISICAL_TOKEN \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$client_id" \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$client_secret" \
    infisical login --method=universal-auth --silent --plain --telemetry=false 2>/dev/null || true
)"
if [[ -z "$token" ]]; then
  echo "::error::Infisical universal-auth login failed." >&2
  exit 1
fi
if [[ "$token" == *$'\n'* || "$token" == *$'\r'* ]]; then
  echo "::error::Infisical returned a multiline token." >&2
  exit 1
fi

key="$(
  INFISICAL_TOKEN="$token" infisical secrets get ASC_KEY_P8 \
    --plain --silent --telemetry=false --expand=false \
    --projectId="$INFISICAL_PROJECT_ID" --env=prod --path=/ \
    2>/dev/null || true
)"
unset token
if [[ -z "$key" ]]; then
  echo "::error::Missing ASC key material in Infisical prod." >&2
  exit 1
fi

export ASC_KEY_P8="$key"
unset key
exec "$@"

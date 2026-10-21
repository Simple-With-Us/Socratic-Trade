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
# THE CREDENTIAL IS RESOLVED FROM TWO PLACES (AFC-459, revision 2):
#   1. APPLE_API_KEY_ID / APPLE_API_ISSUER_ID / APPLE_API_KEY_P8_BASE64, the
#      hosted trio, when all three names are in the environment
#   2. Infisical prod /asc, the folder the ASC trio lives in
# The environment beats the network, in this helper and in the client, so both
# sides resolve the credential the same way.
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

# A masked preview of a value:  the first eight and the last four
# characters, and nothing else.  A value too short to mask safely is
# withheld whole, so a preview can never become the secret it describes.
#
# The shape is the fleet's blessed one (HogHunter #213):  every copy of the
# App Store Connect shell layer masks a refused value the same way.
key_preview() {
  local v="${1:-}" n
  n=${#v}
  if [[ "$n" -eq 0 ]]; then
    printf '%s' "(empty)"
    return 0
  fi
  if [[ "$n" -le 12 ]]; then
    printf '[%d chars, withheld]' "$n"
    return 0
  fi
  printf '%s...%s' "${v:0:8}" "${v: -4}"
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module="${repo_root}/scripts/ios-fleet/asc-key.mjs"

# Refuse a value that is not a usable key, and say so with a masked preview:
# a refused credential has to be identifiable without ever being printed.
refuse_unusable_key() {
  local where="$1" value="$2"
  echo "::error::The ASC key from ${where} is not a PEM private key; preview: $(key_preview "$value")" >&2
  exit 1
}

# The key has to be a key:  the shell layer and the client have to accept
# exactly the same values, so the module parses it before it is handed on.
# A base64 body is accepted too, because the client accepts that form.
usable_pem() {
  local value="$1" decoded=""
  if node "$module" validate >/dev/null 2>&1 <<< "$value"; then
    printf '%s' "$value"
    return 0
  fi
  decoded="$(base64 --decode <<<"$value" 2>/dev/null)" || decoded=""
  if [[ -n "$decoded" ]] && node "$module" validate >/dev/null 2>&1 <<< "$decoded"; then
    printf '%s' "$decoded"
    return 0
  fi
  return 1
}

key=""
source_name=""

# 1. The hosted trio.  The key id, the issuer and the key belong together, so
#    all three names have to be there.
if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" && -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
  case "$APPLE_API_KEY_P8_BASE64" in
    *BEGIN*) key="$APPLE_API_KEY_P8_BASE64" ;;
    #  The encoded value reaches the decoder through a here-string, so the
    #  shell never prints it:  a credential belongs in no output stream.
    *) key="$(base64 --decode <<<"$APPLE_API_KEY_P8_BASE64" 2>/dev/null)" || key="" ;;
  esac
  source_name="the environment"
fi

# 2. Infisical prod, when the environment named no trio.
if [[ -z "$key" ]]; then
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

  #  The ASC trio lives in the /asc folder:  ASC_KEY_ID, ASC_ISSUER_ID and
  #  ASC_KEY_P8 are all there, and every other reader in this repository asks
  #  for that folder.  The root copy of ASC_KEY_P8 is the same value, but the
  #  key id and the issuer are only in /asc, so /asc is the folder that
  #  carries the credential as a whole.
  key="$(
    INFISICAL_TOKEN="$token" infisical secrets get ASC_KEY_P8 \
      --plain --silent --telemetry=false --expand=false \
      --projectId="$INFISICAL_PROJECT_ID" --env=prod --path=/asc \
      2>/dev/null || true
  )"
  unset token
  source_name="Infisical prod"
fi

if [[ -z "$key" ]]; then
  echo "::error::Missing ASC key material in Infisical prod /asc." >&2
  exit 1
fi

# The key has to be a key:  the shell layer and the client have to accept
# exactly the same values, so the module parses it before it is handed on.
pem="$(usable_pem "$key")" || refuse_unusable_key "$source_name" "$key"

export ASC_KEY_P8="$pem"
unset key pem
exec "$@"

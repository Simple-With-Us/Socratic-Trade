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
#   2. Infisical prod, the Fleet-OPS project and its /asc folder first, then
#      this application's root path as a warned fallback (owner ruling
#      2026-10-11, any app may use Fleet-OPS /asc; ruling 2026-10-17)
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

# The App Store Connect credentials live in the Fleet-OPS project, in its
# /asc folder (owner ruling 2026-10-11; any app may use it, ruling
# 2026-10-17).  The constant is the id the other fleet ship lanes read from,
# and the environment may override it with the org secret of the same name.
FLEET_ASC_PROJECT_ID="8dae6d03-8f12-48b2-adf3-e5c1b881c8c5"

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
#
# The resolved key is handed back in a variable, never on stdout:  a
# credential belongs in no output stream, and a command substitution around
# this function would put it on one, where a log, a transcript or anything
# else that captures the output could pick it up.
RESOLVED_PEM=""
usable_pem() {
  local value="$1" decoded=""
  if node "$module" validate >/dev/null 2>&1 <<< "$value"; then
    RESOLVED_PEM="$value"
    return 0
  fi
  decoded="$(base64 -d <<<"$value" 2>/dev/null)" || decoded=""
  if [[ -z "$decoded" ]]; then
    decoded="$(base64 -D <<<"$value" 2>/dev/null)" || decoded=""
  fi
  if [[ -n "$decoded" ]] && node "$module" validate >/dev/null 2>&1 <<< "$decoded"; then
    RESOLVED_PEM="$decoded"
    return 0
  fi
  return 1
}

key=""
source_name=""
hosted_value=""

# 1. The hosted trio.  The key id, the issuer and the key belong together, so
#    all three names have to be there.
if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" && -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
  hosted_value="$APPLE_API_KEY_P8_BASE64"
  #  Whether this host can decode base64 at all is settled with a known-good
  #  body, so a refusal on the operator's value is reported as a bad body and
  #  not as a machine that cannot decode.  The two are different problems and
  #  only one of them is about the credential.
  decoder_ok=0
  if [[ "$(base64 -d <<<'aGVsbG8=' 2>/dev/null)" == "hello" ]] ||
    [[ "$(base64 -D <<<'aGVsbG8=' 2>/dev/null)" == "hello" ]]; then
    decoder_ok=1
  fi
  case "$APPLE_API_KEY_P8_BASE64" in
    *BEGIN*) key="$APPLE_API_KEY_P8_BASE64" ;;
    #  The encoded value reaches the decoder through a here-string, so the
    #  shell never prints it:  a credential belongs in no output stream.
    #
    #  Both flags are tried, because the two base64 implementations disagree
    #  about the name of the decode:  GNU takes -d, BSD takes -D, and a host
    #  whose decoder understands neither would turn a valid hosted key into
    #  an empty one and refuse the run for no reason at all.
    *) key="$(base64 -d <<<"$APPLE_API_KEY_P8_BASE64" 2>/dev/null)" || key=""
       if [[ -z "$key" ]]; then
         key="$(base64 -D <<<"$APPLE_API_KEY_P8_BASE64" 2>/dev/null)" || key=""
       fi
       ;;
  esac
  #  A hosted body that does not decode to a key is a REJECTED credential,
  #  not an absent one.  The operator named this key, so the run stops here
  #  instead of falling through to Infisical and handing the child a key
  #  nobody asked for:  the run would look successful while the credential
  #  the operator named was never the one in use.
  #
  #  The decode is not trusted to fail on a bad body -- BSD decodes what it
  #  can and returns 0, GNU fails on the invalid byte -- so the body is
  #  checked here, where the value the operator set is still in hand and can
  #  be named in the refusal.  A masked preview, never the value.
  if [[ -z "$key" ]] || ! node "$module" validate >/dev/null 2>&1 <<< "$key"; then
    if [[ "$decoder_ok" -eq 0 ]]; then
      echo "::error::No usable base64 decoder on this host, so APPLE_API_KEY_P8_BASE64 could not be read; preview: $(key_preview "$hosted_value")" >&2
    else
      echo "::error::APPLE_API_KEY_P8_BASE64 is set but does not decode to a PEM private key; preview: $(key_preview "$hosted_value")" >&2
    fi
    exit 1
  fi
  source_name="the environment (APPLE_API_KEY_P8_BASE64)"
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

  #  The ASC trio's canonical home is Fleet-OPS /asc (owner ruling 2026-10-11;
  #  any app may use it, ruling 2026-10-17).  The /asc folder belongs to
  #  Fleet-OPS, so it has to be read from THAT project:  INFISICAL_PROJECT_ID
  #  here is the application project, and it has no /asc folder, so a read
  #  against it returns nothing and the lane stops with "Missing ASC key
  #  material" (ST-4579).  The same names in the application project's root
  #  are the fallback, with a warning, so a missing grant on the machine
  #  identity cannot silently stop shipping.
  fleet_asc_project="${ASC_INFISICAL_PROJECT_ID:-$FLEET_ASC_PROJECT_ID}"
  key="$(
    INFISICAL_TOKEN="$token" infisical secrets get ASC_KEY_P8 \
      --plain --silent --telemetry=false --expand=false \
      --projectId="$fleet_asc_project" --env=prod --path=/asc \
      2>/dev/null || true
  )"
  if [[ -z "$key" ]]; then
    echo "::warning::Fleet-OPS /asc is not readable in full; using this project's root path for the ASC key.  Grant the machine identity read on Fleet-OPS /asc." >&2
    key="$(
      INFISICAL_TOKEN="$token" infisical secrets get ASC_KEY_P8 \
        --plain --silent --telemetry=false --expand=false \
        --projectId="$INFISICAL_PROJECT_ID" --env=prod --path=/ \
        2>/dev/null || true
    )"
  fi
  unset token
  source_name="Infisical prod"
fi

if [[ -z "$key" ]]; then
  echo "::error::Missing ASC key material in Infisical prod (Fleet-OPS /asc, then this project's root path)." >&2
  exit 1
fi

# The key has to be a key:  the shell layer and the client have to accept
# exactly the same values, so the module parses it before it is handed on.
# The key is handed back in a variable, so it never passes through stdout.
usable_pem "$key" || refuse_unusable_key "$source_name" "$key"

export ASC_KEY_P8="$RESOLVED_PEM"
unset key RESOLVED_PEM
exec "$@"

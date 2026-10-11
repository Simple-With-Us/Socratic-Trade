#!/usr/bin/env bash
# Safe Infisical helpers for agents — NEVER dumps secret values to stdout/stderr.
#
# Usage:
#   bash scripts/infisical-secrets-safe.sh set KEY=VALUE --projectId ID [--env prod]
#   bash scripts/infisical-secrets-safe.sh has KEY --projectId ID [--env prod]
#   bash scripts/infisical-secrets-safe.sh names --projectId ID [--env prod]
#   bash scripts/infisical-secrets-safe.sh delete KEY --projectId ID --env prod
#
# Environment (owner 2026-10-10):  prod is the only Infisical environment;  dev
# and staging are retired.  The infisical CLI defaults to --env dev, so a call
# without --env would read the wrong environment and report a prod secret as
# missing.  set, has and names add --env prod when none is given.  delete never
# defaults:  it requires an explicit --env prod.  Every command refuses any
# other value (--env X and --env=X).
#
# LLM provider API keys must NEVER be stored in Infisical for Socratic-Trade.
# They belong on Connections (user_api_keys). `set` refuses those names.
#
# Forbidden (agents must not run these):
#   infisical secrets                 # bare list prints every value
#   infisical secrets get KEY --plain # without piping to wc/redaction
#   infisical secrets --output json|yaml|dotenv

set -euo pipefail

die() { echo "infisical-secrets-safe: ERROR: $*" >&2; exit 1; }
info() { echo "infisical-secrets-safe: $*" >&2; }

command -v infisical >/dev/null 2>&1 || die "infisical CLI not found"

# Runtime LLM keys for this app live on Connections, not Infisical. Agents have
# re-created GEMINI_API_KEY / DEEPSEEK_API_KEY in Infisical and then "fixed" the
# app to copy them onto the primary user. Refuse the write.
LLM_RUNTIME_KEYS="OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY GEMINI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY MOONSHOT_API_KEY KIMI_API_KEY MOONSHOTAI_API_KEY OPENROUTER_API_KEY META_API_KEY MINIMAX_API_KEY"

is_llm_runtime_key() {
  local key="$1"
  for k in $LLM_RUNTIME_KEYS; do
    [ "$k" = "$key" ] && return 0
  done
  return 1
}

# Sets ENV_ARGS to the caller's remaining flags with --env prod enforced.
# REQUIRE_EXPLICIT_ENV=1 (delete) refuses a call that has no --env at all.
REQUIRE_EXPLICIT_ENV=0
ENV_ARGS=()
normalize_env() {
  local seen=0 want=0 a
  ENV_ARGS=()
  for a in "$@"; do
    if [ "$want" = 1 ]; then
      [ "$a" = "prod" ] || die "refusing --env '${a:0:20}':  prod is the only Infisical environment (dev and staging are retired)"
      ENV_ARGS+=("$a"); want=0
      continue
    fi
    case "$a" in
      --env)
        seen=1; want=1; ENV_ARGS+=("$a")
        ;;
      --env=*)
        seen=1
        [ "${a#--env=}" = "prod" ] || die "refusing '${a:0:26}':  prod is the only Infisical environment (dev and staging are retired)"
        ENV_ARGS+=("$a")
        ;;
      *)
        ENV_ARGS+=("$a")
        ;;
    esac
  done
  [ "$want" = 0 ] || die "--env needs a value;  only prod is allowed"
  if [ "$seen" = 0 ]; then
    [ "$REQUIRE_EXPLICIT_ENV" = 0 ] || die "this command needs an explicit --env prod (it never defaults)"
    ENV_ARGS+=(--env prod)
  fi
}

cmd="${1:-}"; shift || true
[ -n "$cmd" ] || die "missing command (set|has|names|delete)"

# Reject known-leaky patterns if someone passes them by mistake
for a in "$@"; do
  case "$a" in
    --plain|--output=*|json|yaml|dotenv)
      # allow --plain only for has (we consume it ourselves)
      if [ "$cmd" != "has" ] || [ "$a" != "--plain" ]; then
        if [ "$a" = "--plain" ] && [ "$cmd" = "has" ]; then
          :
        elif [[ "$a" == --output* ]] || [ "$a" = "json" ] || [ "$a" = "yaml" ] || [ "$a" = "dotenv" ]; then
          die "refusing $a — dumps secret values. Use set/has/names only."
        fi
      fi
      ;;
  esac
done

case "$cmd" in
  set)
    pair="${1:-}"; shift || true
    [ -n "$pair" ] || die "usage: set KEY=VALUE --projectId ID [--env prod]"
    case "$pair" in
      *=*) ;;
      *) die "set argument must be KEY=VALUE" ;;
    esac
    key="${pair%%=*}"
    if is_llm_runtime_key "$key"; then
      die "refusing to set $key — LLM runtime keys must not live in Infisical for Socratic-Trade; paste them on Connections"
    fi
    normalize_env "$@"
    # never echo value
    infisical secrets set "$pair" "${ENV_ARGS[@]}" >/dev/null
    info "set ok key=$key"
    ;;
  has)
    key="${1:-}"; shift || true
    [ -n "$key" ] || die "usage: has KEY --projectId ID [--env prod]"
    normalize_env "$@"
    # capture plain value and only print length
    val="$(infisical secrets get "$key" --plain "${ENV_ARGS[@]}" 2>/dev/null || true)"
    if [ -z "$val" ]; then
      info "missing key=$key"
      exit 1
    fi
    info "present key=$key len=${#val}"
    ;;
  names)
    normalize_env "$@"
    # List key NAMES only via JSON + jq, never print secretValue
    raw="$(infisical secrets --output json "${ENV_ARGS[@]}" 2>/dev/null || true)"
    [ -n "$raw" ] || die "names: empty response"
    if command -v jq >/dev/null 2>&1; then
      # Coolify/Infisical shapes vary; try common paths
      echo "$raw" | jq -r '
        if type=="array" then .[]
        elif .secrets then .secrets[]
        else empty end
        | (.secretKey // .key // .name // empty)
      ' | sort -u
    else
      die "jq required for names"
    fi
    ;;
  delete)
    key="${1:-}"; shift || true
    [ -n "$key" ] || die "usage: delete KEY --projectId ID --env prod"
    REQUIRE_EXPLICIT_ENV=1
    normalize_env "$@"
    # Default CLI type is personal; project secrets are shared.
    infisical secrets delete "$key" --type shared --silent "${ENV_ARGS[@]}" >/dev/null
    info "deleted key=$key"
    ;;
  *)
    die "unknown command: $cmd"
    ;;
esac

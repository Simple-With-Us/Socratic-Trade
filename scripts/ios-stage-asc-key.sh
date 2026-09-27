#!/usr/bin/env bash
# Read the multiline ASC private key from stdin.  Publish only its file path.
set +o xtrace
set -euo pipefail
: "${GITHUB_ENV:?GITHUB_ENV is required}"

# A unique directory avoids following an existing AuthKey.p8 compatibility link.
# In CI the hosted runner removes this temporary directory when the job ends.
umask 077
staging_root="${ASC_STAGING_ROOT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
staging_dir="$(mktemp -d "${staging_root%/}/asc-signing.XXXXXX")"
key_path="${staging_dir}/AuthKey.p8"
published=0
trap 'if [[ "$published" == 0 ]]; then rm -rf "$staging_dir"; fi' EXIT
chmod 700 "$staging_dir"

# Normalize CRLF and trailing whitespace without logging key material.
tr -d '\r' | sed 's/[[:space:]]*$//' > "$key_path"
chmod 600 "$key_path"
if ! grep -q '[^[:space:]]' "$key_path"; then
  echo 'error: empty ASC key material' >&2
  exit 1
fi

printf 'ASC_KEY_PATH=%s\n' "$key_path" >> "$GITHUB_ENV"
published=1

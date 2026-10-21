#!/usr/bin/env bash
# The hosted-job credential handoff:  a step that calls the App Store Connect
# client gets the key in the environment, never as a path and never through
# the environment file.
#
# Everything here is synthetic:  the key is a fixture generated at test time,
# the Infisical CLI is a fake, and no network is involved.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

cat > "$tmp_dir/fixture" <<'KEY'
-----BEGIN PRIVATE KEY-----
SYNTHETIC-MULTILINE-FIXTURE-DO-NOT-USE
-----END PRIVATE KEY-----
KEY

cat > "$tmp_dir/bin/infisical" <<'CLI'
#!/usr/bin/env bash
case "${1:-}" in
  login) printf '%s\n' synthetic-session-token ;;
  secrets)
    if [[ "${3:-}" == ASC_KEY_P8 ]]; then
      cat "$ASC_TEST_FIXTURE"
    else
      printf 'synthetic-%s\n' "${3:-value}"
    fi
    ;;
  *) exit 1 ;;
esac
CLI
chmod 700 "$tmp_dir/bin/infisical"

# The child reports what it received, without printing the key itself.
cat > "$tmp_dir/child.sh" <<'CHILD'
#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${ASC_KEY_P8:-}" ]]; then
  echo "no-key" >&2
  exit 1
fi
if [[ "$ASC_KEY_P8" != "$(cat "$ASC_TEST_FIXTURE")" ]]; then
  echo "wrong-key" >&2
  exit 1
fi
# The key must not be in the arguments either.
for arg in "$@"; do
  case "$arg" in
    *SYNTHETIC-MULTILINE-FIXTURE*) echo "key-in-argv" >&2; exit 1 ;;
  esac
done
echo "key-received"
CHILD
chmod 700 "$tmp_dir/child.sh"

export PATH="$tmp_dir/bin:$PATH"
export ASC_TEST_FIXTURE="$tmp_dir/fixture"
export INFISICAL_PROJECT_ID=synthetic-project
export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=synthetic-client
export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=synthetic-secret

# 1. The child receives the key in its environment.
out="$(bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" one two 2>"$tmp_dir/stderr")"
[[ "$out" == "key-received" ]] || { echo "the child did not receive the key" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }

# 2. The key never reaches stdout, stderr or the arguments of the helper.
if grep -Fq 'SYNTHETIC-MULTILINE-FIXTURE' "$tmp_dir/stderr"; then
  echo "key material reached stderr" >&2
  exit 1
fi

# 3. The helper writes nothing to the environment file and leaves no key file.
export GITHUB_ENV="$tmp_dir/github-env"
: > "$GITHUB_ENV"
bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >/dev/null 2>&1
if grep -Fq 'SYNTHETIC-MULTILINE-FIXTURE' "$GITHUB_ENV"; then
  echo "key material reached the environment file" >&2
  exit 1
fi
[[ ! -s "$GITHUB_ENV" ]]

# 4. A missing key fails closed, and the failure says nothing about the key.
: > "$tmp_dir/empty-fixture"
export ASC_TEST_FIXTURE="$tmp_dir/empty-fixture"
if bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >"$tmp_dir/stdout" 2>"$tmp_dir/stderr"; then
  echo "a missing key was accepted" >&2
  exit 1
fi
grep -q 'Missing ASC key material' "$tmp_dir/stderr"

# 5. Without a command it is a usage error, and it does not touch Infisical.
if bash "$repo_root/scripts/ios-asc-key-env.sh" >/dev/null 2>&1; then
  echo "the helper accepted a missing command" >&2
  exit 1
fi

# 6. Without a machine identity it fails closed before it asks Infisical.
unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
if bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >/dev/null 2>"$tmp_dir/stderr"; then
  echo "the helper ran without a machine identity" >&2
  exit 1
fi
grep -q 'Missing Infisical machine identity' "$tmp_dir/stderr"

echo 'synthetic ASC credential handoff passed'

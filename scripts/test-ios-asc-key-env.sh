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

# The test's own log stub:  it writes to a file, so a note the code under test
# leaves behind is something the test can look at.  A no-op stub would make
# every log assertion vacuous.
log() { echo "$*" >> "${ASC_TEST_LOG:-/dev/null}"; }
export ASC_TEST_LOG="${tmp_dir}/test.log"
: > "$ASC_TEST_LOG"

# A throwaway key, generated here and never committed.  The helper parses the
# key before it hands it on, so a fake envelope is not enough.
node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }))' \
  > "$tmp_dir/fixture"
chmod 600 "$tmp_dir/fixture"

# The needle for a leak:  one distinctive line of the key body.
key_needle="$(sed -n '2p' "$tmp_dir/fixture")"
[[ "${#key_needle}" -gt 32 ]] || { echo "the fixture key has no body line to look for" >&2; exit 1; }

cat > "$tmp_dir/bin/infisical" <<'CLI'
#!/usr/bin/env bash
# The fake answers the ASC key only from the /asc folder, which is where the
# ASC trio lives, and only from the project that folder belongs to:  the
# /asc folder is the Fleet-OPS one (owner ruling 2026-10-11; any app may use
# it, ruling 2026-10-17), so a helper that asks the wrong folder or the
# wrong project gets nothing, and the suite catches it.
#
# The application project ALSO answers from its root path.  That is the
# control:  a helper that fell back to, or was pointed at, the application
# project would still hand a key on, so only the "never asked" assertions
# below can tell the single-source helper from one with a fallback.
secret_path=""
secret_project=""
for arg in "$@"; do
  case "$arg" in
    --path=*) secret_path="${arg#--path=}" ;;
    --projectId=*) secret_project="${arg#--projectId=}" ;;
  esac
done
case "${1:-}" in
  login) printf '%s\n' synthetic-session-token ;;
  secrets)
    echo "asked Infisical for ${3:-value} at ${secret_path:-/} in ${secret_project:-none}" >> "${ASC_TEST_LOG}"
    if [[ "${3:-}" == ASC_KEY_P8 ]]; then
      if [[ "$secret_project" == "${ASC_TEST_FLEET_PROJECT:-}" ]] &&
         [[ "$secret_path" == /asc ]] &&
         [[ "${ASC_TEST_FLEET_READABLE:-1}" == "1" ]]; then
        cat "$ASC_TEST_FIXTURE"
        exit 0
      fi
      if [[ "$secret_project" == "${ASC_TEST_APP_PROJECT:-}" ]] &&
         [[ "$secret_path" == / ]]; then
        cat "$ASC_TEST_FIXTURE"
        exit 0
      fi
      exit 3
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
    *BEGIN\ PRIVATE\ KEY*) echo "key-in-argv" >&2; exit 1 ;;
  esac
done
echo "key-received"
CHILD
chmod 700 "$tmp_dir/child.sh"

export PATH="$tmp_dir/bin:$PATH"
export ASC_TEST_FIXTURE="$tmp_dir/fixture"
# The application project is this repository's own Infisical project.  The
# fleet project is the one that owns the /asc folder, so the two are
# deliberately different here.
export INFISICAL_PROJECT_ID=synthetic-app-project
# The fleet project id is the one constant in the helper:  it is not
# overridable, so the fake has to answer for that exact id.
export ASC_TEST_APP_PROJECT=synthetic-app-project
export ASC_TEST_FLEET_PROJECT=8dae6d03-8f12-48b2-adf3-e5c1b881c8c5
export ASC_TEST_FLEET_READABLE=1
export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=synthetic-client
export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=synthetic-secret

# 1. The child receives the key in its environment.
out="$(bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" one two 2>"$tmp_dir/stderr")"
[[ "$out" == "key-received" ]] || { echo "the child did not receive the key" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
log "the child received the key in its environment"

# 1a. The key is read from the /asc folder, the one the ASC trio lives in:
# every other reader of this credential in the repository asks for that
# folder, and a reader that asks the wrong one gets nothing at all.
grep -q 'asked Infisical for ASC_KEY_P8 at /asc' "$ASC_TEST_LOG" ||
  { echo "the key was not read from the /asc folder" >&2; cat "$ASC_TEST_LOG" >&2; exit 1; }

# 1b. The /asc folder belongs to the fleet project, so the read that asks for
# it has to name that project.  This repository's own project id is the
# application project, and it has no /asc folder at all, so a read against it
# returns nothing and the ship lane stops with "Missing ASC key material"
# (ST-4579).
grep -q "asked Infisical for ASC_KEY_P8 at /asc in ${ASC_TEST_FLEET_PROJECT}" "$ASC_TEST_LOG" ||
  { echo "the /asc read did not name the fleet project" >&2; cat "$ASC_TEST_LOG" >&2; exit 1; }
# 1c. The application project is never asked for the key, although the fake
# would answer from its root:  this is the control that fails for the old
# application-project lookup and for any fallback to it.
if grep -q "in ${ASC_TEST_APP_PROJECT}" "$ASC_TEST_LOG"; then
  echo "the application project was asked for the ASC key" >&2; cat "$ASC_TEST_LOG" >&2; exit 1
fi

# 2. The key never reaches stdout, stderr or the arguments of the helper.
if grep -Fq "$key_needle" "$tmp_dir/stderr"; then
  echo "key material reached stderr" >&2
  exit 1
fi

# 3. The helper writes nothing to the environment file and leaves no key file.
export GITHUB_ENV="$tmp_dir/github-env"
: > "$GITHUB_ENV"
bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >/dev/null 2>&1
if grep -Fq "$key_needle" "$GITHUB_ENV"; then
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
grep -q 'Missing required secret ASC_KEY_P8' "$tmp_dir/stderr"

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
export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=synthetic-client
export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=synthetic-secret

# 7. A value that is not a key is refused with its source and error class,
# and no fragment of the value appears:  not the whole value, not its first
# eight characters and not its last four.  Synthetic value only.
export ASC_TEST_FIXTURE="$tmp_dir/bad-fixture"
printf 'not a private key at all' > "$tmp_dir/bad-fixture"
if bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >"$tmp_dir/stdout" 2>"$tmp_dir/stderr"; then
  echo "a value that is not a key was accepted" >&2
  exit 1
fi
grep -q 'is not a PEM private key' "$tmp_dir/stderr" ||
  { echo "the refusal did not name the reason" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
grep -Fq 'The ASC key from Infisical prod is not' "$tmp_dir/stderr" ||
  { echo "the refusal did not name its source" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
grep -q 'error: invalid-key-format' "$tmp_dir/stderr" ||
  { echo "the refusal did not name the error class" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
for fragment in 'not a private key at all' 'not a pr' ' all' 'preview'; do
  if grep -Fq -- "$fragment" "$tmp_dir/stderr" "$tmp_dir/stdout"; then
    echo "the refusal carried a fragment of the refused value: $fragment" >&2
    exit 1
  fi
done
log "a value that is not a key was refused without any fragment of it"

# 8. The hosted trio in the environment wins over Infisical, and the base64
# body is decoded through a here-string:  the environment beats the network,
# in the helper and in the client.
export ASC_TEST_FIXTURE="$tmp_dir/fixture"
encoded="$(base64 < "$tmp_dir/fixture" | tr -d '\n')"
: > "$ASC_TEST_LOG"
out="$(APPLE_API_KEY_ID=APPLEKEY01 APPLE_API_ISSUER_ID=apple-issuer \
  APPLE_API_KEY_P8_BASE64="$encoded" \
  bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" 2>"$tmp_dir/stderr")"
[[ "$out" == "key-received" ]] || { echo "the child did not receive the key" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
if grep -q 'asked Infisical' "$ASC_TEST_LOG"; then
  echo "Infisical was asked although the environment held the key" >&2
  exit 1
fi
if grep -Fq "$key_needle" "$tmp_dir/stderr"; then
  echo "key material reached stderr" >&2
  exit 1
fi
log "the hosted trio was used without asking Infisical"

# 9. The log stub writes to a file:  a note that was never written would make
# every log assertion vacuous.
grep -q 'the hosted trio was used' "$ASC_TEST_LOG" ||
  { echo "the log stub wrote nothing to the log file" >&2; exit 1; }

# 10. The resolved key never passes through stdout.  A function that prints a
# credential is a credential in a log, in a transcript and in whatever captures
# that output next, so the key is handed back in a variable instead.  The
# refusal line names no part of the value either (case 7), so the guard looks for the two shapes that would print the key itself.
helper="$repo_root/scripts/ios-asc-key-env.sh"
#  The pattern is only worth anything while it still recognizes the forms it
#  forbids.  A pattern that stopped matching would let this guard pass
#  without detecting anything at all, which is worse than no guard, because
#  it reads as a passing check.  So a synthetic fixture carrying the former
#  stdout-producing form is matched against the same pattern first.
stdout_pattern="printf '%s' \"\\\$(value|decoded)\"|\\\$\(usable_pem"
probe_print="$tmp_dir/probe-stdout-print.sh"
cat > "$probe_print" <<'PROBE'
usable_pem() {
  printf '%s' "$decoded"
}
PROBE
if ! grep -qE "$stdout_pattern" "$probe_print"; then
  echo "the stdout guard no longer recognizes the form it forbids" >&2
  cat "$probe_print" >&2
  exit 1
fi
probe_capture="$tmp_dir/probe-stdout-capture.sh"
cat > "$probe_capture" <<'PROBE'
p8="$(usable_pem "$APPLE_API_KEY_P8_BASE64")"
PROBE
if ! grep -qE "$stdout_pattern" "$probe_capture"; then
  echo "the stdout guard no longer recognizes the command substitution" >&2
  cat "$probe_capture" >&2
  exit 1
fi
if grep -nE "$stdout_pattern" "$helper" >/dev/null; then
  echo "the helper writes the resolved key to stdout" >&2
  grep -nE "$stdout_pattern" "$helper" >&2
  exit 1
fi
log "the resolved key is handed over in a variable, never on stdout"

# 11. A hosted body that does not decode is a REJECTED credential, not an
# absent one.  The operator named this key, so the helper must stop instead
# of falling through to Infisical and handing the child a key nobody asked
# for:  the run would look successful while the credential the operator
# named was never the one in use.  The refusal names the variable and the
# error class, and neither the key ID nor any fragment of the value.  Synthetic value only.
rejected='not base64 at all !!!'
rejected_first8="$(printf '%s' "$rejected" | cut -c1-8)"
rejected_last4="$(printf '%s' "$rejected" | tail -c 4)"
: > "$ASC_TEST_LOG"
if APPLE_API_KEY_ID=APPLEKEY01 APPLE_API_ISSUER_ID=apple-issuer \
  APPLE_API_KEY_P8_BASE64="$rejected" \
  bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >"$tmp_dir/stdout" 2>"$tmp_dir/stderr"; then
  echo "a hosted body that does not decode was accepted" >&2
  exit 1
fi
if grep -q 'asked Infisical' "$ASC_TEST_LOG"; then
  echo "a rejected hosted credential fell through to Infisical" >&2
  exit 1
fi
grep -q 'APPLE_API_KEY_P8_BASE64' "$tmp_dir/stderr" ||
  { echo "the refusal did not name the rejected variable" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
if grep -Fq 'APPLEKEY01' "$tmp_dir/stderr" "$tmp_dir/stdout"; then
  echo "the refusal printed the key ID to the log" >&2; exit 1
fi
grep -q 'error: invalid-hosted-key' "$tmp_dir/stderr" ||
  { echo "the refusal did not name the error class" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
for fragment in "$rejected" "$rejected_first8" "$rejected_last4" 'preview' 'APPLEKEY01'; do
  if grep -Fq -- "$fragment" "$tmp_dir/stderr" "$tmp_dir/stdout"; then
    echo "the refusal carried a fragment of the rejected value: $fragment" >&2
    exit 1
  fi
done
log "a hosted body that does not decode was refused instead of falling through"

# 12. When Fleet-OPS /asc cannot be read, the helper stops:  there is no
#     second source (owner policy 2026-10-24, no fallbacks).  The error names
#     the missing secret, and the application project, which the fake would
#     answer from, is never asked.
export ASC_TEST_FLEET_READABLE=0
: > "$ASC_TEST_LOG"
if bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" >"$tmp_dir/stdout" 2>"$tmp_dir/stderr"; then
  echo "an unreadable Fleet-OPS /asc was accepted" >&2; exit 1
fi
grep -q 'Missing required secret ASC_KEY_P8' "$tmp_dir/stderr" ||
  { echo "the failure did not name ASC_KEY_P8" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
if grep -q "in ${ASC_TEST_APP_PROJECT}" "$ASC_TEST_LOG"; then
  echo "the helper fell back to the application project" >&2; cat "$ASC_TEST_LOG" >&2; exit 1
fi
export ASC_TEST_FLEET_READABLE=1
log "an unreadable Fleet-OPS /asc failed closed and named ASC_KEY_P8"

# 13. An ambient project override is ignored:  the source is not
#     overridable, so a runner that happens to export one still reads
#     Fleet-OPS /asc.
: > "$ASC_TEST_LOG"
out="$(ASC_INFISICAL_PROJECT_ID=synthetic-other-project \
  bash "$repo_root/scripts/ios-asc-key-env.sh" bash "$tmp_dir/child.sh" 2>"$tmp_dir/stderr")"
[[ "$out" == "key-received" ]] ||
  { echo "an ambient override changed the result" >&2; cat "$tmp_dir/stderr" >&2; exit 1; }
if grep -q 'synthetic-other-project' "$ASC_TEST_LOG"; then
  echo "an ambient override redirected the /asc read" >&2; cat "$ASC_TEST_LOG" >&2; exit 1
fi

echo 'synthetic ASC credential handoff passed'

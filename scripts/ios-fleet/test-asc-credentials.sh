#!/usr/bin/env bash
# AFC-459 (revision 2): ship-testflight.sh resolves the App Store Connect
# credential from the environment first, then from Infisical through
# fleet-secrets, and never from a path on disk.  A named ASC_KEY_PATH is
# ignored:  a path is not an approved credential source.
#
# 2026-10-21: the private key is handed over in the environment, never as a
# path the node client reads.  The shell layer owns the credential, so this
# test drives load_secrets with a FAKE fleet-secrets binary and throwaway keys
# generated here at test time.  No network, no real secrets, and no committed
# key.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/ship-testflight.sh"
tmp="$(mktemp -d)"
# The throwaway HOME lives inside the temp dir, so the cleanup has to run with
# the real HOME in place:  a trash helper that protects the home directory
# refuses to remove a parent of it.
real_home="${HOME}"
trap 'HOME="$real_home" rm -rf "$tmp"' EXIT
export HOME="${tmp}/home"
export TMPDIR="${tmp}/tmp"
mkdir -p "$HOME" "$TMPDIR"

fail() { echo "FAIL: $*" >&2; exit 1; }

# A throwaway key pair, generated here and never committed.  The client parses
# a PEM before it accepts it, so a fake envelope is not a key.
gen_pem() {
  node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }))'
}
gen_pem > "${tmp}/asc.p8"
gen_pem > "${tmp}/other.p8"
chmod 600 "${tmp}/asc.p8" "${tmp}/other.p8"

# Fake fleet-secrets: prints synthetic values, records the folders it was asked for.
cat > "${tmp}/fleet-secrets" <<'FAKE'
#!/usr/bin/env bash
[[ "$1" == get ]] || exit 2
name="$2"; folder="$4"
echo "${name} ${folder}" >> "${FAKE_LOG}"
case "${folder}:${name}" in
  /asc:ASC_KEY_ID) printf 'ABCDE12345\n' ;;
  /asc:ASC_ISSUER_ID) printf 'issuer-synthetic\n' ;;
  /asc:ASC_KEY_P8) cat "${FAKE_ASC_PEM}" ;;
  /authkey-otherkey01-p8:AUTHKEY_OTHERKEY01) cat "${FAKE_OTHER_PEM}" ;;
  *) exit 3 ;;
esac
FAKE
chmod +x "${tmp}/fleet-secrets"
export FAKE_LOG="${tmp}/fake.log"
export FAKE_ASC_PEM="${tmp}/asc.p8"
export FAKE_OTHER_PEM="${tmp}/other.p8"
: > "$FAKE_LOG"

extract() {
  awk '
    /^fleet_secret_get\(\) \{/ || /^load_secrets\(\) \{/ || /^asc_cleanup\(\) \{/ || /^key_preview\(\) \{/ { grab = 1 }
    grab { print }
    grab && /^\}/ { grab = 0 }
  ' "$script"
}

# The comparison tool.  It answers through the exit code only, so a
# credential is never expanded into the shell, where a trace would show it.
#
#   same <file>          the value in VALUE_TO_COMPARE equals the file
#   different <file>      the value in VALUE_TO_COMPARE differs from the file
#   samefile <a> <b>     the two files hold the same key
#   differentfile <a> <b> the two files hold different keys
cat > "${tmp}/compare.cjs" <<'CJS'
const fs = require("fs");
const mode = process.argv[2];
const first = process.argv[3];
const second = process.argv[4];
const value = process.env.VALUE_TO_COMPARE || "";
const read = (path) => fs.readFileSync(path, "utf8").trim();
const equal = second ? read(first) === read(second) : value.trim() === read(first);
const wantsDifferent = mode === "different" || mode === "differentfile";
process.exit(wantsDifferent ? (equal ? 1 : 0) : (equal ? 0 : 1));
CJS

funcs="${tmp}/funcs.sh"
{
  echo 'log() { echo "$*" >> "${ASC_TEST_LOG:-/dev/null}"; }'
  echo 'die() { echo "error: $*" >&2; exit 1; }'
  echo 'ASC_TMP_DIR=""'
  echo "FLEET_SECRETS_BIN=\"${tmp}/fleet-secrets\""
  echo "FLEET_DIR=\"${here}\""
  echo "ASC_COMPARE_TOOL=\"${tmp}/compare.cjs\""
  cat <<'FUNCS'
same_as_file() {
  VALUE_TO_COMPARE="$1" node "$ASC_COMPARE_TOOL" same "$2"
}
different_from_file() {
  VALUE_TO_COMPARE="$1" node "$ASC_COMPARE_TOOL" different "$2"
}
same_file_as_file() {
  node "$ASC_COMPARE_TOOL" samefile "$1" "$2"
}
different_file_from_file() {
  node "$ASC_COMPARE_TOOL" differentfile "$1" "$2"
}
FUNCS
  extract
} > "$funcs"
export ASC_TEST_LOG="${tmp}/log.txt"
: > "$ASC_TEST_LOG"
grep -q '^load_secrets()' "$funcs" || fail "load_secrets not found in ship-testflight.sh"
grep -q '^fleet_secret_get()' "$funcs" || fail "fleet_secret_get not found in ship-testflight.sh"
grep -q '^key_preview()' "$funcs" || fail "key_preview not found in ship-testflight.sh"

# 1. Nothing in the environment:  credentials come from Infisical, the key is a 0600 temp file.
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key ]]
  [[ "$ASC_KEY_ID" == ABCDE12345 && "$ASC_ISSUER_ID" == issuer-synthetic ]]
  [[ -f "$ASC_KEY_PATH" ]]
  mode="$(stat -c %a "$ASC_KEY_PATH" 2>/dev/null || stat -f %Lp "$ASC_KEY_PATH")"
  [[ "$mode" == 600 ]]
  [[ "$API_PRIVATE_KEYS_DIR" == "$ASC_TMP_DIR" ]]
  # The staged file holds the /asc key, and the client takes the key from the
  # environment.  Neither comparison prints a value.
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  same_as_file "$ASC_KEY_P8" "'"$tmp"'/asc.p8"
  echo "$ASC_KEY_PATH"
  asc_cleanup
  [[ ! -e "$ASC_KEY_PATH" ]]
')" || fail "load_secrets from Infisical"
[[ ! -e "$out" ]] || fail "temp key file survived cleanup"
grep -q '^ASC_KEY_ID /asc$' "$FAKE_LOG" || fail "did not ask Infisical /asc for the key id"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask Infisical /asc for the key"

# 2. The environment wins over a named key file.  A disk credential never
# overrides the environment (AFC-459, revision 2):  a stale or foreign value
# in an operator's shell would sign the upload with the wrong key.
: > "$FAKE_LOG"
cp "${tmp}/asc.p8" "${tmp}/named-key.p8"
chmod 600 "${tmp}/named-key.p8"
ASC_KEY_ID=ENVKEY0001 ASC_ISSUER_ID=env-issuer \
  ASC_KEY_P8="$(<"${tmp}/other.p8")" ASC_KEY_PATH="${tmp}/named-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ENVKEY0001 ]]
  # The environment key is the credential in play, and the named file is not.
  same_as_file "$ASC_KEY_P8" "'"$tmp"'/other.p8"
  different_from_file "$ASC_KEY_P8" "'"$tmp"'/named-key.p8"
' || fail "a named key file overrode the environment"
[[ ! -s "$FAKE_LOG" ]] || fail "fleet-secrets was called although the environment was complete"

# 2a. A named ASC_KEY_PATH is not a credential source at all:  it is ignored,
# and the credential comes from Infisical.  A file somebody names can never
# decide which key signs the upload (AFC-459, revision 2).
: > "$FAKE_LOG"
: > "$ASC_TEST_LOG"
cp "${tmp}/other.p8" "${tmp}/named-file.p8"
chmod 600 "${tmp}/named-file.p8"
env -u ASC_KEY_P8 ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_PATH="${tmp}/named-file.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  # The credential is the /asc one from Infisical, never the named file.
  same_as_file "$ASC_KEY_P8" "'"$tmp"'/asc.p8"
  different_from_file "$ASC_KEY_P8" "'"$tmp"'/named-file.p8"
  # The staged file is the materialization the Apple tools read, and it is
  # not the path that was named.
  different_file_from_file "$ASC_KEY_PATH" "'"$tmp"'/named-file.p8"
  asc_cleanup
' || fail "a named key file was used as the credential"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "fleet-secrets was not consulted for the credential"
grep -q 'ASC_KEY_PATH is not a credential source' "$ASC_TEST_LOG" ||
  fail "the run did not say that it ignored the named ASC_KEY_PATH"

# The scanner that finds a command substitution which runs the key reader.
#
# It walks the file and matches the closing parenthesis of every
# substitution, so a capture is found whatever shape it has:  with or without
# a `||` after it, written on one line or across several, and with a nested
# substitution inside it.  The scan is exact, so the script as it stands is
# not flagged by a shape it does not have.
cat > "${tmp}/find-key-capture.cjs" <<'SCAN'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const offenders = [];
const lineOf = (index) => text.slice(0, index).split("\n").length;
let depth = 0;
let start = 0;
let quote = null;
for (let i = 0; i < text.length; i += 1) {
  const c = text[i];
  if (quote === "'") {
    //  Single quotes are literal in bash, so nothing inside them is a
    //  substitution.
    if (c === quote) quote = null;
    continue;
  }
  if (c === "\\") { i += 1; continue; }
  if (c === "`") {
    const end = text.indexOf("`", i + 1);
    if (end === -1) break;
    if (text.slice(i, end + 1).includes("asc-key.mjs")) offenders.push(lineOf(i));
    i = end;
    continue;
  }
  if (quote === "\"") {
    if (c === quote) { quote = null; continue; }
    if (c === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i); if (end !== -1) { i = end; continue; } }
    if (c === "$" && text[i + 1] === "(") { depth += 1; if (depth === 1) start = i; i += 1; continue; }
    if (c === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0 && text.slice(start, i + 1).includes("asc-key.mjs")) offenders.push(lineOf(start));
    }
    continue;
  }
  if (c === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i); if (end !== -1) { i = end; continue; } }
  if (c === "#") {
    //  A comment runs to the end of the line, and an apostrophe in it is an
    //  apostrophe, not the start of a quoted string.
    const end = text.indexOf("\n", i);
    i = end === -1 ? text.length : end;
    continue;
  }
  if (c === "\"" || c === "'") { quote = c; continue; }
  if (c === "$" && text[i + 1] === "(") { depth += 1; if (depth === 1) start = i; i += 1; continue; }
  if (c === ")" && depth > 0) {
    depth -= 1;
    if (depth === 0 && text.slice(start, i + 1).includes("asc-key.mjs")) offenders.push(lineOf(start));
  }
}
if (offenders.length) {
  console.error("the key reader is captured into a variable at line(s) " + offenders.join(", "));
  process.exit(1);
}
SCAN

# 2b. A staged key file is never read into a variable:  the shell that owns it
# only ever holds its path.
if ! node "${tmp}/find-key-capture.cjs" "$script"; then
  fail "ship-testflight.sh reads the key material into a variable"
fi

# 2b. The guard has teeth:  a capture in every shape is caught, and the ship
# script as it stands is not flagged.
for shape in plain plain-with-or split-across-lines nested; do
  cp "$script" "${tmp}/mutated.sh"
  case "$shape" in
    plain)
      printf '%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" read "$ASC_KEY_PATH")"' >> "${tmp}/mutated.sh" ;;
    plain-with-or)
      printf '%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" read "$ASC_KEY_PATH")" || rc=$?' >> "${tmp}/mutated.sh" ;;
    split-across-lines)
      printf '%s\n%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" \' '  read "$ASC_KEY_PATH")"' >> "${tmp}/mutated.sh" ;;
    nested)
      printf '%s\n' 'key="$(cd "$(dirname "$0")"; node "${FLEET_DIR}/asc-key.mjs" read "$ASC_KEY_PATH")"' >> "${tmp}/mutated.sh" ;;
  esac
  if node "${tmp}/find-key-capture.cjs" "${tmp}/mutated.sh" >/dev/null 2>&1; then
    fail "the capture guard did not catch a ${shape} capture"
  fi
done

# 2c. An ambient ASC_KEY_P8 that is not a PEM private key is fatal, and the
# message carries a masked preview of the value, so the value that failed can
# be identified without the key material being printed.
: > "$FAKE_LOG"
: > "$ASC_TEST_LOG"
if ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_P8="not a private key at all" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets required
' 2>"${tmp}/invalid-key.err"; then
  fail "an ASC_KEY_P8 that is not a key was accepted"
fi
grep -q 'does not hold a PEM private key' "${tmp}/invalid-key.err" ||
  fail "the refused ASC_KEY_P8 was not named in the failure"
grep -Fq 'preview: not a pr... all' "${tmp}/invalid-key.err" ||
  fail "the refused ASC_KEY_P8 carried no masked preview"

# 2c-quiet. A refused value never reaches a log line with its body in it.
if grep -Fq 'not a private key at all' "${tmp}/invalid-key.err" "$ASC_TEST_LOG"; then
  fail "the refused ASC_KEY_P8 was printed"
fi

# 2c-preview. A value that carries the PEM envelope is previewed too:  the
# first eight and the last four characters of the VALUE, and nothing else.
# The fixture body is obviously fake, and the line carries the scanner marker.
bad_pem="$(printf '%s\n%s\n%s' '-----BEGIN PRIVATE KEY-----' 'SYNTHETICBADBODYHERE' '-----END PRIVATE KEY-----')" # gitleaks:allow
if ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_P8="$bad_pem" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets required
' 2>"${tmp}/preview.err"; then
  fail "an ASC_KEY_P8 that is not a key was accepted"
fi
grep -Fq 'preview: -----BEG...----' "${tmp}/preview.err" ||
  fail "the masked preview of the refused value is not the first-eight/last-four form"
if grep -Fq 'SYNTHETICBADBODYHERE' "${tmp}/preview.err"; then
  fail "the whole PEM body was printed"
fi

# 2c-bis. A PEM stored with literal backslash-n separators is a real key, so
# the separators become newlines before the module sees the value.  Without
# this, the key is refused and the run fails closed on a key that is fine.
literal="$(printf '%s' "$(cat "${tmp}/other.p8")" | sed 's/$/\\n/' | tr -d '\n')"
: > "$FAKE_LOG"
ASC_KEY_ID=ENVKEYLIT1 ASC_ISSUER_ID=env-issuer ASC_KEY_P8="$literal" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ENVKEYLIT1 ]]
  # The staged file holds a real PEM, with real newlines.
  grep -q -- "-----BEGIN PRIVATE KEY-----" "$ASC_KEY_PATH" || exit 1
  head -1 "$ASC_KEY_PATH" | grep -q -- "-----BEGIN PRIVATE KEY-----" || exit 1
  # And the key the client is handed is the same key.
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/other.p8"
  asc_cleanup
' || fail "a PEM stored with literal backslash-n separators was refused"

# 2d. An ambient ASC_KEY_P8 without a key id is fatal:  the key id, the
# issuer and the key belong together, and the failure names what is missing.
: > "$FAKE_LOG"
if ASC_KEY_ID="" ASC_ISSUER_ID="" ASC_KEY_P8="$(<"${tmp}/other.p8")" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets required
' 2>"${tmp}/no-key-id.err"; then
  fail "an ASC_KEY_P8 without a key id was accepted"
fi
grep -q 'ASC_KEY_ID is missing' "${tmp}/no-key-id.err" ||
  fail "the missing key id was not named in the failure"

# 2e. An env key id that is NOT the /asc one never gets the /asc key:  its own .p8 comes from
# /authkey-<id>-p8, and /asc ASC_KEY_P8 is not requested.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 ASC_KEY_ID=OTHERKEY01 ASC_ISSUER_ID=issuer-other bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == OTHERKEY01 ]]
  [[ "$ASC_ISSUER_ID" == issuer-other ]]
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/other.p8"
  different_file_from_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  asc_cleanup
' || fail "env key id different from /asc was not given its own key"
grep -q '^AUTHKEY_OTHERKEY01 /authkey-otherkey01-p8$' "$FAKE_LOG" || fail "did not ask the per-key folder"
if grep -q '^ASC_KEY_P8 ' "$FAKE_LOG"; then fail "mixed an env key id with the /asc key"; fi

# 2f. An env key id that is not the /asc one with NO env issuer fails closed:  the /asc issuer
# is never paired with another key's .p8, and the failure names what is missing.
: > "$FAKE_LOG"
if env -u ASC_KEY_PATH -u ASC_ISSUER_ID -u ASC_KEY_P8 ASC_KEY_ID=OTHERKEY01 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets required
' 2>"${tmp}/no-issuer.err"; then
  fail "mixed the /asc issuer with another key"
fi
grep -q 'ASC_ISSUER_ID is missing' "${tmp}/no-issuer.err" ||
  fail "the missing issuer was not named in the failure"
if grep -q '^ASC_ISSUER_ID ' "$FAKE_LOG"; then fail "asked /asc for an issuer for a different key id"; fi

# 2g. An env key id equal to the /asc one uses the /asc key.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_ISSUER_ID -u ASC_KEY_P8 ASC_KEY_ID=ABCDE12345 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  asc_cleanup
' || fail "env key id equal to /asc was not served from /asc"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask /asc ASC_KEY_P8"

# 2h. An env key id with no key material anywhere fails closed, and the
# failure names the key whose material is missing.
: > "$FAKE_LOG"
if env -u ASC_KEY_PATH -u ASC_KEY_P8 ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets required
' 2>"${tmp}/no-key-material.err"; then
  fail "missing key material did not fail closed"
fi
grep -q 'the .p8 for key NOSUCHKEY0 is missing' "${tmp}/no-key-material.err" ||
  fail "the missing key material was not named in the failure"

# 2i. A named ASC_KEY_PATH that names nothing is ignored the same way:  the
# credential comes from Infisical, and the named path is never read.
: > "$FAKE_LOG"
env -u ASC_KEY_P8 ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_PATH="${tmp}/no-such-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  same_as_file "$ASC_KEY_P8" "'"$tmp"'/asc.p8"
  asc_cleanup
' || fail "a named key file that names nothing broke the run"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "fleet-secrets was not consulted for the credential"

# 2k. The hosted APPLE_API_* trio:  the key id, the issuer and the key belong
# together, and the p8 body is base64.  The trio wins over every other
# source, so fleet-secrets is never asked.
#
# The encoded value reaches the decoder through a here-string, so the shell
# never prints it:  a credential belongs in no output stream.
: > "$FAKE_LOG"
encoded="$(base64 < "${tmp}/other.p8" | tr -d '\n')"
APPLE_API_KEY_ID=APPLEKEY01 APPLE_API_ISSUER_ID=apple-issuer \
  APPLE_API_KEY_P8_BASE64="$encoded" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == APPLEKEY01 ]]
  [[ "$ASC_ISSUER_ID" == apple-issuer ]]
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/other.p8"
  asc_cleanup
' || fail "the hosted APPLE_API_* trio was not used"
[[ ! -s "$FAKE_LOG" ]] || fail "fleet-secrets was called although the environment was complete"
if ! grep -q 'base64 --decode <<<"\$APPLE_API_KEY_P8_BASE64"' "$script"; then
  fail "the base64 body is not decoded through a here-string"
fi
if grep -qE 'base64 --decode[^|]*\|[^|]' "$script"; then
  fail "the base64 body is decoded through a pipe"
fi

# 2k-bis. An APPLE_API_KEY_P8_BASE64 that is not a key is refused, and the
# refusal carries a masked preview of the value, never the value.
#
# The fixture is real base64, so the case does not depend on how the local
# base64 treats invalid input:  BSD and GNU disagree about that, and the
# hosted runner is not the local machine.
encoded_bad="$(printf 'not a private key at all' | base64 | tr -d '\n')"
bad_preview="$(printf '%s' "$encoded_bad" | cut -c1-8)...$(printf '%s' "$encoded_bad" | tail -c 4)"
if APPLE_API_KEY_ID=APPLEKEY01 APPLE_API_ISSUER_ID=apple-issuer \
  APPLE_API_KEY_P8_BASE64="$encoded_bad" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets required
' 2>"${tmp}/invalid-base64.err"; then
  fail "an APPLE_API_KEY_P8_BASE64 that is not a key was accepted"
fi
grep -Fq "preview: ${bad_preview}" "${tmp}/invalid-base64.err" ||
  fail "the refused APPLE_API_KEY_P8_BASE64 carried no masked preview"
if grep -Fq 'not a private key at all' "${tmp}/invalid-base64.err"; then
  fail "the refused APPLE_API_KEY_P8_BASE64 was printed"
fi

# 2j. The hosted workflow hands the key to the step that calls the client in
# the environment, and the environment file never carries key material.  A
# path in ASC_KEY_PATH is not a credential source, so a workflow that
# publishes only the path leaves the ship with no credential and the sequence
# floor unverifiable.
workflow="${here}/../../.github/workflows/ios-ship.yml"
if [[ -f "$workflow" ]]; then
  grep -q 'scripts/ios-asc-key-env.sh' "$workflow" ||
    fail "the hosted workflow does not hand ASC_KEY_P8 to the step that calls the client"
  if grep -q 'ASC_KEY_P8<<EOF' "$workflow"; then
    fail "the hosted workflow puts key material in the environment file"
  fi
fi

# 2j-bis. The early call leaves the credential optional:  the build phase may
# never reach App Store Connect, so a missing credential is reported and the
# run continues.  The call that requires it is the one before the upload.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 -u ASC_KEY_ID -u ASC_ISSUER_ID bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  #  No reader at all, so there is no source left for the credential.
  FLEET_SECRETS_BIN=/nonexistent/fleet-secrets
  PATH="$(dirname "$(command -v node)"):/usr/bin:/bin"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "the optional call did not survive a missing credential"

# 3. The credential never travels in a command argument.  The secret reaches
#    the child through the environment, so its own argv must not carry it.
#
#    THE PROOF IS THE SIGNED REQUEST (fleet alignment, 2026-10-21):  the
#    client is handed the key in its environment, and the JWT it sends
#    verifies against exactly that key.  Nothing here reads another
#    process's environment:  a process listing is another process's
#    business, it is not portable, and it says nothing about which key
#    actually signed anything.
cat > "${tmp}/signed-request.cjs" <<'CJS'
const fs = require("fs");
const { spawn } = require("child_process");
const { createPublicKey, createVerify } = require("crypto");
const { createServer } = require("http");

const clientPath = process.argv[2];
const keyPath = process.argv[3];
const keyId = process.argv[4];

// The client runs only when the path it was started with is the path its own
// module reports, and node resolves a symlinked directory to its real path.
// So the harness starts it by its real path:  the lane lives behind one.
const clientReal = fs.realpathSync(clientPath);

// The test reads its OWN fixture;  the client never reads a file.
const pem = fs.readFileSync(keyPath, "utf8");
const bodyLine = pem.split("\n").find((line) => line.length > 32) || "";

let token = "";
const server = createServer((req, res) => {
  token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [] }));
});

const refuse = (why) => {
  console.error(why);
  server.close();
  process.exit(1);
};

server.listen(0, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const args = [clientReal, "GET", `${base}/v1/apps`];
  const child = spawn(process.execPath, args, {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.ASC_SAFE_HOME || "/tmp",
      ASC_KEY_ID: keyId,
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_P8: pem
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (code) => {
    if (code !== 0) refuse("the client refused the key in its environment");
    if (bodyLine && args.join(" ").includes(bodyLine)) refuse("the key reached the client's arguments");
    if (bodyLine && (stdout.includes(bodyLine) || stderr.includes(bodyLine))) {
      refuse("the key reached the client's output");
    }
    const parts = token.split(".");
    if (parts.length !== 3) refuse("the client sent no signed request");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (header.kid !== keyId) refuse("the request was signed with another key id");
    const verifier = createVerify("SHA256");
    verifier.update(Buffer.from(`${parts[0]}.${parts[1]}`));
    verifier.end();
    let signed = false;
    try {
      signed = verifier.verify(
        { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
        Buffer.from(parts[2], "base64url")
      );
    } catch {
      signed = false;
    }
    if (!signed) refuse("the request was not signed with the key in the environment");
    server.close();
    process.stdout.write("signed-with-the-environment-key\n");
  });
});
CJS

mkdir -p "${tmp}/client-home"
out="$(ASC_SAFE_HOME="${tmp}/client-home" node "${tmp}/signed-request.cjs" \
  "${here}/asc-api.mjs" "${tmp}/other.p8" ENVKEY0005 2>"${tmp}/signed.err")" ||
  fail "the request was not signed with the key handed over in the environment"
[[ "$out" == "signed-with-the-environment-key" ]] ||
  fail "the client did not sign the request with the key in its environment"

# 4. Neither this test nor the ship script passes a credential to `env`, which
# would put it in the process arguments of every child.
for f in "$0" "$script"; do
  if grep -nE '(^|[[:space:]])env [^|]*ASC_KEY_P8=' "$f" >/dev/null; then
    fail "$(basename "$f") passes a credential through env arguments"
  fi
done

# 5. Nothing is created under the old secrets folder or ~/.appstoreconnect.
[[ ! -e "${HOME}/.secrets" ]] || fail "created the old secrets folder"
[[ ! -e "${HOME}/.appstoreconnect" ]] || fail "created ~/.appstoreconnect"

# 6. The script text itself no longer names the old folder as a source.
if grep -nE '(~|\$\{?HOME\}?)/\.secrets' "$script" >/dev/null; then
  fail "ship-testflight.sh still names the old secrets folder"
fi

echo "ok: ASC credential resolution (environment first, then Infisical, a named path ignored, temp key removed)"

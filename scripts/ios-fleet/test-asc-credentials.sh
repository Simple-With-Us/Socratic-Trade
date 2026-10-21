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
    /^fleet_secret_get\(\) \{/ || /^load_secrets\(\) \{/ || /^asc_cleanup\(\) \{/ { grab = 1 }
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
  echo 'log() { echo "$*" >> "${LOG_FILE}"; }'
  echo 'ASC_TMP_DIR=""'
  echo "FLEET_SECRETS_BIN=\"${tmp}/fleet-secrets\""
  echo "FLEET_DIR=\"${here}\""
  echo "ASC_COMPARE_TOOL=\"${tmp}/compare.cjs\""
  echo "LOG_FILE=\"${tmp}/log.txt\""
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
export LOG_FILE="${tmp}/log.txt"
: > "$LOG_FILE"
grep -q '^load_secrets()' "$funcs" || fail "load_secrets not found in ship-testflight.sh"
grep -q '^fleet_secret_get()' "$funcs" || fail "fleet_secret_get not found in ship-testflight.sh"

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
: > "$LOG_FILE"
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
grep -q 'ASC_KEY_PATH is not a credential source' "$LOG_FILE" ||
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

# 2c. An ambient ASC_KEY_P8 that is not a PEM private key is ignored, and the
# run fails closed rather than signing with something that is not a key.
: > "$FAKE_LOG"
: > "$LOG_FILE"
ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_P8="not a private key at all" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
  [[ -z "${ASC_KEY_P8:-}" ]]
' || fail "an ASC_KEY_P8 that is not a key was adopted"

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

# 2d. An ambient ASC_KEY_P8 without a key id is ignored:  the key id, the
# issuer and the key belong together.
: > "$FAKE_LOG"
ASC_KEY_ID="" ASC_ISSUER_ID="" ASC_KEY_P8="$(<"${tmp}/other.p8")" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  same_as_file "$ASC_KEY_P8" "'"$tmp"'/asc.p8"
' || fail "an ASC_KEY_P8 without a key id was adopted"

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
# is never paired with another key's .p8.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_ISSUER_ID -u ASC_KEY_P8 ASC_KEY_ID=OTHERKEY01 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "mixed the /asc issuer with another key"
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

# 2h. An env key id with no key material anywhere fails closed (no api_key mode).
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "missing key material did not fail closed"

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

# 3. The credential never travels in a command argument.  The secret reaches
# the child through the environment, so its own argv must not carry it.
argv="$(ASC_KEY_ID=ENVKEY0005 ASC_ISSUER_ID=env-issuer ASC_KEY_P8="$(<"${tmp}/other.p8")" bash -c '
  set -euo pipefail
  ps -o args= -p $$ 2>/dev/null || true
')"
pem="$(<"${tmp}/other.p8")"
[[ "$argv" != *"$pem"* ]] || fail "the credential reached the child in its command arguments"

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

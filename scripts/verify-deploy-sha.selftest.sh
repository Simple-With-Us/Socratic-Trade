#!/usr/bin/env bash
# verify-deploy-sha.selftest.sh - hermetic exit-code matrix for scripts/verify-deploy-sha.sh.
#
# The deploy gate is a shell script, so the vitest suite cannot cover it, and "we will find out
# after the next merge" is not verification. This builds a throwaway git repo with a known history
# and serves a stub /api/health from localhost, then asserts the exact exit code for every state
# the gate is supposed to distinguish. No network, no production, no secrets - safe in CI.
#
# It exists because the first draft of the gate had a silent parsing bug this matrix caught: the
# obvious `jq '[...] | @tsv'` + `IFS=$'\t' read` idiom collapses empty fields (tab is IFS
# whitespace), so a MISSING release sha shifted the next field into place and the gate believed
# production had published a release id it never published. That is the exact failure mode - a
# check that reports success on absent data - this whole effort is about eliminating, so the case
# is pinned here permanently.
#
# Usage: bash scripts/verify-deploy-sha.selftest.sh
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/verify-deploy-sha.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required for the stub server." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-deploy-sha-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cat > "${WORK}/stub.py" <<'PY'
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

BODY = os.environ.get("STUB_BODY", "{}").encode()
STATUS = int(os.environ.get("STUB_STATUS", "200"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(STATUS)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w") as fh:
    fh.write(str(server.server_port))
server.serve_forever()
PY

# A throwaway history so the matrix never depends on real commits (which the fleet rewrites and
# the janitor prunes): C1 -> C2 -> C3 on the trunk, plus D branching off C1 so there is a pair of
# commits where neither contains the other.
REPO="${WORK}/repo"
mkdir -p "$REPO"
git init -q "$REPO"
gitc() { git -C "$REPO" -c user.email=selftest@example.invalid -c user.name=selftest "$@"; }
mkcommit() { echo "$1" > "${REPO}/file.txt"; gitc add file.txt; gitc commit -q -m "$1"; gitc rev-parse HEAD; }

C1="$(mkcommit c1)"
C2="$(mkcommit c2)"
C3="$(mkcommit c3)"
gitc checkout -q -b sidebranch "$C1"
D="$(mkcommit d)"
gitc checkout -q "$C3"

PASSES=0
FAILURES=0

# $1 name, $2 expected exit, $3 expected-ref argument, $4 stub http status, $5 stub body
run_case() {
  local name="$1" want="$2" expect_ref="$3" status="$4" body="$5"
  local portfile="${WORK}/port"
  rm -f "$portfile"
  STUB_BODY="$body" STUB_STATUS="$status" python3 "${WORK}/stub.py" "$portfile" >/dev/null 2>&1 &
  local pid=$!

  local waited=0
  while [ ! -s "$portfile" ]; do
    waited=$((waited + 1))
    [ "$waited" -gt 100 ] && { echo "FAIL  ${name} (stub server never bound a port)"; FAILURES=$((FAILURES + 1)); kill "$pid" 2>/dev/null; return; }
    sleep 0.1
  done
  local port
  port="$(cat "$portfile")"

  local out code
  out="$(cd "$REPO" && DEPLOY_VERIFY_HOST="http://127.0.0.1:${port}" DEPLOY_VERIFY_TIMEOUT_SECONDS=0 \
    DEPLOY_VERIFY_NO_FETCH=1 bash "$UNDER_TEST" "$expect_ref" 2>&1)"
  code=$?
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  if [ "$code" = "$want" ]; then
    echo "PASS  ${name} (exit ${code})"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL  ${name} (exit ${code}, wanted ${want})"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  fi
}

payload() {
  # $1 release-sha JSON literal (already quoted, or the bare word null), $2 processUptimeSeconds
  printf '{"ok":true,"checks":{"db":"ok","schedulerAgeSeconds":25,"release":{"sha":%s,"processUptimeSeconds":%s}}}' "$1" "$2"
}

run_case "live == expected"                0 "$C3" 200 "$(payload "\"${C3}\"" 9000)"
run_case "live AHEAD of expected"          0 "$C1" 200 "$(payload "\"${C3}\"" 9000)"
run_case "live ahead, SHORT sha published" 0 "$C1" 200 "$(payload "\"$(printf '%.7s' "$C3")\"" 9000)"
run_case "live BEHIND expected"            3 "$C3" 200 "$(payload "\"${C1}\"" 9000)"
run_case "divergent commit"                4 "$D"  200 "$(payload "\"${C3}\"" 10)"
run_case "release sha null"                2 "$C3" 200 "$(payload null 9000)"
# The discriminating case for the field-shift bug described in the header. A container that has
# been up more than ~11.6 days reports a 7-digit processUptimeSeconds, and 7 decimal digits are
# also valid hex - so a collapsing parser slides the uptime into the sha slot and the gate reports
# "production is running 1200000, which is not a commit in this repo" (exit 5) instead of the true
# and actionable "the app publishes no release sha" (exit 2). Same failure either way, but one of
# them sends the operator hunting a phantom commit.
run_case "sha null, uptime looks like hex" 2 "$C3" 200 "$(payload null 1200000)"
run_case "release section absent"          2 "$C3" 200 '{"ok":true,"checks":{"db":"ok"}}'
run_case "release id is not a sha"         2 "$C3" 200 "$(payload '"not-a-commit"' 9000)"
run_case "commit unknown to this repo"     5 "$C3" 200 "$(payload '"0123456789abcdef0123456789abcdef01234567"' 10)"
run_case "degraded 503 body still parsed"  0 "$C3" 503 "$(payload "\"${C3}\"" 50)"
run_case "non-JSON edge error page"        1 "$C3" 200 '<html>502 Bad Gateway</html>'
run_case "expected ref unresolvable"       1 "no-such-ref" 200 "$(payload "\"${C3}\"" 9000)"

echo "---- ${PASSES} passed, ${FAILURES} failed ----"
[ "$FAILURES" = "0" ]

#!/usr/bin/env bash
# alert-deploy-freshness.selftest.sh - hermetic matrix for the deploy-freshness watchdog.
#
# Builds a throwaway git history + localhost /api/health stub (same pattern as
# verify-deploy-sha.selftest.sh). No production, no Slack, no secrets.
#
# Usage: bash scripts/alert-deploy-freshness.selftest.sh
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/alert-deploy-freshness.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-freshness-selftest.XXXXXX")"
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

REPO="${WORK}/repo"
mkdir -p "$REPO"
git init -q "$REPO"
gitc() { git -C "$REPO" -c user.email=selftest@example.invalid -c user.name=selftest "$@"; }
# $1 message, $2 date (optional), $3 path (optional).
#
# The default path is inside Coolify's watch_paths, so a commit to it changed
# the running image and owes a deployment.  A commit to a path outside the
# list owes none, and must never age the watchdog's verdict - that is the
# false positive ST-4575 was about.
mkcommit() {
  local msg="$1" date="${2:-}" path="${3:-src/app.ts}"
  mkdir -p "${REPO}/$(dirname "$path")"
  echo "$msg" > "${REPO}/${path}"
  gitc add "$path"
  if [ -n "$date" ]; then
    GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" gitc commit -q -m "$msg"
  else
    gitc commit -q -m "$msg"
  fi
  gitc rev-parse HEAD
}

# C1 (old) -> C2 (2.5h ago, the first undeployed when live=C1) -> C3 (tip, recent)
# plus D off C1 for divergence.
OLD_DATE="$(python3 -c 'import time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-20000)))')"
MID_DATE="$(python3 -c 'import time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-9000)))')"
C1="$(mkcommit c1 "$OLD_DATE")"
C2="$(mkcommit c2 "$MID_DATE")"
C3="$(mkcommit c3)"
gitc checkout -q -b sidebranch "$C1"
D="$(mkcommit d)"
gitc checkout -q "$C3"

# ST-4575 fixtures.  N1 changes only a CI workflow file, so Coolify never owed
# a deployment for it.  C4 changes a watched path and is minutes old.  N1 lands
# before C4, so a watchdog that ages the oldest commit in the gap regardless
# of what it changed reports C4 as hours stale.
NOOP_DATE="$(python3 -c 'import time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-28800)))')"
FRESH_DATE="$(python3 -c 'import time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-600)))')"
N1="$(mkcommit n1 "$NOOP_DATE" ".github/workflows/ci.yml")"
C4="$(mkcommit c4 "$FRESH_DATE")"

# A subdirectory of the fixture repo.  The watchdog resolves a pathspec against
# its working directory, so a run started here would resolve every watched
# path to <repo>/subdir/<path>, match nothing, and report a fresh image-noop
# pass - a permanently silent watchdog.  The directory is untracked on purpose:
# it is a place to run FROM, not a change to classify.
mkdir -p "${REPO}/subdir"
echo "keep" > "${REPO}/subdir/keep.txt"

# A git shim that fails only for rev-list.  It lets the selftest prove that a
# git failure is an operational error and never a fresh image-noop pass.
REAL_GIT="$(command -v git)"
mkdir -p "${WORK}/shim"
cat > "${WORK}/shim/git" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "rev-list" ]; then
  echo "fatal: simulated git rev-list failure" >&2
  exit 128
fi
exec "${REAL_GIT}" "\$@"
SH
chmod +x "${WORK}/shim/git"

# A second git shim that writes a WARNING to stderr and still exits 0, the
# way git does when $HOME is unreadable.  The watchdog captures stdout only,
# so a warning line can never become the first "commit" of the list and send
# the next git log off the documented exit-code contract.
mkdir -p "${WORK}/shim-warn"
cat > "${WORK}/shim-warn/git" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "rev-list" ]; then
  echo "warning: unable to access '/root/.gitconfig': Permission denied" >&2
fi
exec "${REAL_GIT}" "\$@"
SH
chmod +x "${WORK}/shim-warn/git"

# The control for the RUN_CWD cases.  A non-interactive bash sources BASH_ENV
# at startup, so the probe records the directory every child bash actually
# started in.  Without it the subdirectory case would pass whether or not
# RUN_CWD was honored, because a run from the repository root produces the
# same verdict and the case would guard nothing.  The probe APPENDS, and the
# control reads the FIRST record, because the script under test is the first
# bash to start and it is the one whose starting directory is under test.
CWD_PROBE="${WORK}/cwd-probe.txt"
cat > "${WORK}/cwd-probe.sh" <<'SH'
pwd >> "${CWD_PROBE_FILE:-/dev/null}" 2>/dev/null || true
SH

PASSES=0
FAILURES=0

payload() {
  printf '{"ok":true,"checks":{"db":"ok","schedulerAgeSeconds":25,"release":{"sha":%s,"processUptimeSeconds":%s}}}' "$1" "$2"
}

# Set EXPECT_OUTPUT to a substring the run must print, empty for no check.
EXPECT_OUTPUT=""

# The directory the script under test runs from, relative to the fixture repo.
# Empty means the repo root.  Set it to prove the watchdog anchors itself to
# the repository root instead of resolving pathspecs against the caller's cwd.
RUN_CWD=""

# When set, the run is only valid if the script under test actually STARTED
# in a directory whose path ends with this suffix.  Empty means no control.
EXPECT_CWD_SUFFIX=""

# $1 name, $2 expected exit, $3 expected-ref, $4 stub status, $5 stub body, $6 extra env assignments
run_case() {
  local name="$1" want="$2" expect_ref="$3" status="$4" body="$5"
  shift 5
  local portfile="${WORK}/port"
  rm -f "$portfile"
  STUB_BODY="$body" STUB_STATUS="$status" python3 "${WORK}/stub.py" "$portfile" >/dev/null 2>&1 &
  local pid=$!

  local waited=0
  while [ ! -s "$portfile" ]; do
    waited=$((waited + 1))
    [ "$waited" -gt 100 ] && { echo "FAIL  ${name} (stub never bound)"; FAILURES=$((FAILURES + 1)); kill "$pid" 2>/dev/null; return; }
    sleep 0.1
  done
  local port
  port="$(cat "$portfile")"

  local workdir="$REPO"
  if [ -n "$RUN_CWD" ]; then
    workdir="${REPO}/${RUN_CWD}"
  fi
  rm -f "$CWD_PROBE"

  local out code
  # Extra KEY=value args cannot be `"$@" bash` prefixes: bash only treats
  # literal (not expanded) words as assignments. Export them instead.
  out="$(
    export DEPLOY_VERIFY_HOST="http://127.0.0.1:${port}"
    export DEPLOY_VERIFY_NO_FETCH=1
    export DEPLOY_FRESHNESS_NOTIFY=0
    export DEPLOY_FRESHNESS_TREAT_UNREACHABLE=1
    export BASH_ENV="${WORK}/cwd-probe.sh"
    export CWD_PROBE_FILE="$CWD_PROBE"
    for assign in "$@"; do
      export "$assign"
    done
    cd "$workdir" && bash "$UNDER_TEST" "$expect_ref" 2>&1
  )"
  code=$?
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  if [ "$code" != "$want" ]; then
    echo "FAIL  ${name} (exit ${code}, wanted ${want})"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [ -n "$EXPECT_OUTPUT" ] && ! printf '%s\n' "$out" | grep -qF "$EXPECT_OUTPUT"; then
    echo "FAIL  ${name} (exit ${code}, output missing '${EXPECT_OUTPUT}')"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
    return
  fi
  # The control.  The verdict alone cannot tell a run from the subdirectory
  # apart from a run from the repository root, so the run has to prove where
  # the script under test started.
  if [ -n "$EXPECT_CWD_SUFFIX" ]; then
    local probed=""
    if [ -f "$CWD_PROBE" ]; then
      probed="$(head -n 1 "$CWD_PROBE")"
    fi
    case "$probed" in
      *"/${EXPECT_CWD_SUFFIX}") ;;
      *)
        echo "FAIL  ${name} (control: the script under test started in '${probed:-unknown}', wanted a path ending in '/${EXPECT_CWD_SUFFIX}')"
        FAILURES=$((FAILURES + 1))
        return
        ;;
    esac
  fi
  echo "PASS  ${name} (exit ${code})"
  PASSES=$((PASSES + 1))
}

run_case "live == expected" 0 "$C3" 200 "$(payload "\"${C3}\"" 9000)"
run_case "live AHEAD of expected" 0 "$C1" 200 "$(payload "\"${C3}\"" 9000)"
run_case "in-flight: behind but newest gap is fresh" 0 "$C3" 200 "$(payload "\"${C2}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=3600
run_case "stale: oldest undeployed is 2.5h old" 3 "$C3" 200 "$(payload "\"${C1}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=3600
run_case "stale suppressed when threshold is huge" 0 "$C3" 200 "$(payload "\"${C1}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=864000
run_case "divergent commit" 4 "$D" 200 "$(payload "\"${C3}\"" 10)"
run_case "release sha null" 2 "$C3" 200 "$(payload null 9000)"
run_case "unreachable treated as OK" 0 "$C3" 200 '<html>502 Bad Gateway</html>'
run_case "unreachable fails when opted in" 1 "$C3" 200 '<html>502 Bad Gateway</html>' \
  DEPLOY_FRESHNESS_TREAT_UNREACHABLE=0

# ST-4575: a gap whose commits cannot change the running image is not a deploy
# gap, so it is fresh.  Before the fix the watchdog aged the CI-only commit
# and reported stale, which paged on four consecutive scheduled runs while
# production was correctly still.
run_case "image-noop gap is fresh, not stale" 0 "$N1" 200 "$(payload "\"${C3}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=3600

# ST-4575: the age comes from the commit that changed a watched path, so an
# old CI-only commit earlier in the gap cannot make a fresh runtime commit
# look stale.  Before the fix this aged N1 and exited 3.
EXPECT_OUTPUT="oldest image-affecting undeployed ${C4}"
run_case "age comes from the watched commit, not an older noop commit" 0 "$C4" 200 "$(payload "\"${C3}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=3600
EXPECT_OUTPUT=""

# ST-4575: the guard still pages when a watched path really is missing.
run_case "still stale when the gap changes a watched path" 3 "$C4" 200 "$(payload "\"${C3}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=60

# A git failure is an operational error, not a verdict.  If the rev-list exit
# status is swallowed, an empty list is indistinguishable from a failed git,
# and the failure becomes a green image-noop pass - a watchdog that claims to
# have checked while it did not.  The same failure used to abort the script
# under `set -e`, and it must keep failing loudly.
#
# The expected output pins the failure to the rev-list branch.  Several
# unrelated guards also exit 1, so the exit code alone cannot show that the
# rev-list error handling is what fired.
EXPECT_OUTPUT="git rev-list failed"
run_case "a git failure is an operational error, not a fresh pass" 1 "$C4" 200 "$(payload "\"${C3}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=60 \
  "PATH=${WORK}/shim:${PATH}"
EXPECT_OUTPUT=""

# The watchdog must anchor itself to the repository root.  Git resolves a
# pathspec against the working directory, so a run started from a subdirectory
# resolves every watched path to <repo>/subdir/<path>, matches nothing, and
# reports a fresh image-noop pass.  The gap here DOES change a watched path
# (C4), so the verdict must still be stale.
#
# The control is the point of the case.  A run from the repository root gives
# the same stale verdict, so the verdict alone cannot tell whether the run
# really started in the subdirectory.  The probe records where the script
# under test started, and the case fails unless that was the subdirectory.
RUN_CWD="subdir"
EXPECT_CWD_SUFFIX="subdir"
run_case "a run from a subdirectory still ages the watched commit" 3 "$C4" 200 "$(payload "\"${C3}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=60
RUN_CWD=""
EXPECT_CWD_SUFFIX=""

# A git WARNING on stderr with a zero exit must not change the verdict.  If
# the warning were merged into the captured commit list, it would become the
# first "commit", the next git log would fail on a non-sha argument, and the
# script would die with git's own exit 128, which is outside the exit-code
# contract this script documents.  The verdict here must be a normal stale.
run_case "a git warning on stderr does not break the verdict" 3 "$C4" 200 "$(payload "\"${C3}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=60 \
  "PATH=${WORK}/shim-warn:${PATH}"

echo "---- ${PASSES} passed, ${FAILURES} failed ----"
[ "$FAILURES" = "0" ]

#!/usr/bin/env bash
# Contract tests for the merge shepherd's tracking issue (ST-4553):  it is opt-in, the lookup lists
# issues over REST instead of searching, the oldest duplicate wins, and a failed lookup never
# creates an issue.  A stub `gh` on PATH records every call;  nothing reaches GitHub.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${ROOT}/scripts/merge-shepherd.sh"

bash -n "$SCRIPT"

STUB="$(mktemp -d)"
trap 'rm -rf "$STUB"' EXIT
cat >"$STUB/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >>"$GH_LOG"
if [ "$1" = "api" ]; then
  case "$GH_MODE" in
    fail) echo "HTTP 403: API rate limit exceeded" >&2; exit 1 ;;
    none) exit 0 ;;
    dups) printf '4848\n12\n300\n' ;;
  esac
fi
exit 0
GH
chmod +x "$STUB/gh"
export PATH="$STUB:$PATH" GH_LOG="$STUB/calls"

REPO="Simple-With-Us/Socratic-Trade"
ISSUE_TITLE="Merge shepherd status"
set +e
set -uo pipefail
eval "$(sed -n '/^find_status_issue()/,/^}/p' "$SCRIPT")"
eval "$(sed -n '/^publish_status_issue()/,/^}/p' "$SCRIPT")"

fail=0
run() {  # mode -> the gh calls publish_status_issue made, one per line
  : >"$GH_LOG"
  GH_MODE="$1" publish_status_issue "digest" >/dev/null 2>&1
  cat "$GH_LOG"
}
expect() {  # description, calls, pattern that must match, pattern that must not
  if ! grep -q -- "$3" <<<"$2" || { [ -n "$4" ] && grep -q -- "$4" <<<"$2"; }; then
    echo "FAIL $1:" >&2; echo "$2" >&2; fail=1
  fi
}

calls="$(run fail)"
expect "a failed lookup creates nothing" "$calls" "^api --paginate repos/$REPO/issues" "issue create"
calls="$(run none)"
expect "no open issue creates one" "$calls" "^issue create -R $REPO --title $ISSUE_TITLE" "issue edit"
calls="$(run dups)"
expect "duplicates update the oldest" "$calls" "^issue edit 12 -R $REPO" "issue create"
expect "the lookup never searches" "$(run none)$(run dups)" "api" "search"

# Opt-in:  the main flow only publishes when SHEPHERD_STATUS_ISSUE=1, and it defaults to 0.
grep -q '^STATUS_ISSUE="${SHEPHERD_STATUS_ISSUE:-0}"$' "$SCRIPT" || { echo "FAIL status issue is not off by default" >&2; fail=1; }
grep -q '^if \[ "\$DRY" != "1" \] && \[ "\$STATUS_ISSUE" = "1" \]; then$' "$SCRIPT" \
  || { echo "FAIL publishing is not gated on SHEPHERD_STATUS_ISSUE" >&2; fail=1; }

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "selftest: merge-shepherd status issue ok"

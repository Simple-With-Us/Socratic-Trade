#!/usr/bin/env bash
# agent-sync-ops-notify.selftest.sh - hermetic checks for ops notify formatting.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/agent-sync-ops-notify.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ops-notify-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

STUB="${WORK}/agent-sync"
cat >"$STUB" <<'SH'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    post)
      shift
      while [ $# -gt 0 ]; do
        case "$1" in
          --channel|--topic|--session|--as|--rc) shift 2 ;;
          --no-tag) shift; break ;;
          *) shift ;;
        esac
      done
      printf '%s\n' "$*" >>"${OPS_NOTIFY_LOG:-/dev/null}"
      exit 0
      ;;
    whoami) exit 0 ;;
  esac
  shift
done
exit 2
SH
chmod +x "$STUB"

export PATH="${WORK}:${PATH}"
export OPS_NOTIFY_LOG="${WORK}/posted.log"
export AGENT_SYNC_OPS_NOTIFY=1
export AGENT_SEAT=ST
export ZULIP_ALERTS_TOPIC=Socratic-Trade

FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=$((FAIL + 1)); }

if bash "$UNDER_TEST" post MODERATE "silent freeze" >/dev/null 2>&1; then
  want='MODERATE  •  Socratic-Trade  •  silent freeze'
  got="$(cat "$OPS_NOTIFY_LOG" 2>/dev/null | tail -n 1)"
  if [ "$got" = "$want" ]; then
    pass "severity formatting"
  else
    fail "severity formatting (got: ${got})"
  fi
else
  fail "severity formatting (script errored)"
fi

: >"$OPS_NOTIFY_LOG"
pre='INFO  •  Socratic-Trade  •  knob-sync applied: FOO'
if bash "$UNDER_TEST" post "$pre" >/dev/null 2>&1; then
  got="$(cat "$OPS_NOTIFY_LOG" 2>/dev/null | tail -n 1)"
  if [ "$got" = "$pre" ]; then
    pass "preformatted line"
  else
    fail "preformatted line (got: ${got})"
  fi
else
  fail "preformatted line (script errored)"
fi

export AGENT_SYNC_OPS_NOTIFY=0
: >"$OPS_NOTIFY_LOG"
if bash "$UNDER_TEST" post INFO "skipped" >/dev/null 2>&1 && [ ! -s "$OPS_NOTIFY_LOG" ]; then
  pass "notify flag off"
else
  fail "notify flag off"
fi

if bash "$UNDER_TEST" test >/dev/null 2>&1; then
  pass "test subcommand"
else
  fail "test subcommand"
fi

echo "---- failures: ${FAIL} ----"
[ "$FAIL" = "0" ]

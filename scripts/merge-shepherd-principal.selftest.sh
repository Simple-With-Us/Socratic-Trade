#!/usr/bin/env bash
# Exercise the actual startup guard. Never connects to GitHub.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/merge-shepherd.sh"
bash -n "$SCRIPT"
STUB="$(mktemp -d)"; trap 'rm -rf "$STUB"' EXIT
cat > "$STUB/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  api\ graphql*)
    [ "$MODE" = fail ] && exit 1
    printf '%s\n' "$ACTOR" ;;
  pr\ list*) exit 0 ;;
  *) echo 'unexpected call' >&2; exit 2 ;;
esac
GH
chmod +x "$STUB/gh"
export PATH="$STUB:$PATH" GH_LOG="$STUB/log"
run() {
  : > "$GH_LOG"
  if ACTOR="$2" MODE="$3" SHEPHERD_EXPECTED_ACTOR="$1" bash "$SCRIPT" > "$STUB/out" 2>&1; then code=0; else code=$?; fi
  if [ "$4" = pass ]; then
    [ "$code" = 0 ] && grep -q '^pr list' "$GH_LOG" || { cat "$STUB/out"; exit 1; }
  else
    [ "$code" != 0 ] && ! grep -q '^pr ' "$GH_LOG" || { cat "$STUB/out"; exit 1; }
  fi
}
run 'swu-wise[bot]' 'swu-wise[bot]' ok pass
run 'swu-wise[bot]' jaywedgeworth22 ok fail
run jaywedgeworth22 jaywedgeworth22 ok fail
run 'swu-wise[bot]' 'swu-echo[bot]' ok fail
run '' 'swu-wise[bot]' ok fail
run 'swu-wise[bot]' '' ok fail
run 'swu-wise[bot]' 'swu-wise[bot]' fail fail
# There is no REST identity read or silent Actions-bot substitution.
! grep -q 'gh api user' "$SCRIPT"
! grep -q 'ME="${ME:-github-actions' "$SCRIPT"
echo 'selftest: merge-shepherd principal guard 7 cases ok'

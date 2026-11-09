#!/usr/bin/env bash
# isolate-shared-box-batch.selftest.sh - classification matrix, no docker, no host.
#
# Usage: bash scripts/isolate-shared-box-batch.selftest.sh
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/isolate-shared-box-batch.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/isolate-batch-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# id<TAB>name  -- mixed fleet as seen on the shared Coolify host
cat > "${WORK}/ps.tsv" <<'EOF'
aaa111	socratic-app-live
bbb222	coolify
ccc333	usage-monitor
ddd444	congress-scan-cpu-worker
eee555	congress-app-live
fff666	ocr-batch-1
ggg777	unrelated-redis
hhh888	socratic-ocr-hypothetical
iii999	mock-st-app-uuid
EOF

PASSES=0
FAILURES=0

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -Fq "$needle"; then
    echo "PASS  ${name}"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL  ${name} (missing: ${needle})"
    printf '%s\n' "$haystack" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -Fq "$needle"; then
    echo "FAIL  ${name} (unexpected: ${needle})"
    printf '%s\n' "$haystack" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS  ${name}"
    PASSES=$((PASSES + 1))
  fi
}

OUT="$(bash "$UNDER_TEST" --docker-ps-file "${WORK}/ps.tsv" 2>&1)"
CODE=$?
if [ "$CODE" = "0" ]; then
  echo "PASS  dry-run exit 0"
  PASSES=$((PASSES + 1))
else
  echo "FAIL  dry-run exit ${CODE}"
  FAILURES=$((FAILURES + 1))
fi

assert_contains "caps dedicated scan worker" "cap  ddd444  congress-scan-cpu-worker  worker" "$OUT"
assert_contains "caps ocr-named container" "cap  fff666  ocr-batch-1  worker" "$OUT"
assert_contains "skips ST app" "skip  aaa111  socratic-app-live  protected" "$OUT"
assert_contains "skips Coolify" "skip  bbb222  coolify  protected" "$OUT"
assert_contains "skips UM" "skip  ccc333  usage-monitor  protected" "$OUT"
assert_contains "skips ST uuid" "skip  iii999  mock-st-app-uuid  protected" "$OUT"
assert_contains "protected wins over ocr in the name" "skip  hhh888  socratic-ocr-hypothetical  protected" "$OUT"
assert_contains "congress app skipped without --include-app" "skip  eee555  congress-app-live  app" "$OUT"
assert_contains "unrelated skipped" "skip  ggg777  unrelated-redis  other" "$OUT"
assert_contains "names the remaining constraint" "remaining host constraint: docker update is ephemeral" "$OUT"
assert_contains "default OCR cap is 5 of 8 vCPU" "cpu-shares=256 cpus=5" "$OUT"

# No dedicated worker: must still refuse to touch ST and must name the in-process OCR gap.
cat > "${WORK}/ps-noworker.tsv" <<'EOF'
aaa111	socratic-app-live
eee555	congress-app-live
EOF
OUT_NW="$(bash "$UNDER_TEST" --docker-ps-file "${WORK}/ps-noworker.tsv" 2>&1)"
assert_contains "no-worker names in-process OCR gap" "CT OCR likely shares the congress-app process" "$OUT_NW"
assert_not_contains "no-worker does not cap ST" "cap  aaa111" "$OUT_NW"
assert_not_contains "no-worker does not cap CT app by default" "cap  eee555" "$OUT_NW"

OUT_APP="$(bash "$UNDER_TEST" --docker-ps-file "${WORK}/ps.tsv" --include-app 2>&1)"
assert_contains "include-app caps congress app" "cap  eee555  congress-app-live  app" "$OUT_APP"
assert_contains "include-app still protects ST" "skip  aaa111  socratic-app-live  protected" "$OUT_APP"

# --apply without the env latch must refuse (and must not need docker).
set +e
OUT_REFUSE="$(bash "$UNDER_TEST" --docker-ps-file "${WORK}/ps.tsv" --apply 2>&1)"
REFUSE_CODE=$?
set -e
if [ "$REFUSE_CODE" != "0" ] && printf '%s' "$OUT_REFUSE" | grep -Fq "ISOLATE_SHARED_BOX_APPLY"; then
  echo "PASS  --apply refused without latch"
  PASSES=$((PASSES + 1))
else
  echo "FAIL  --apply latch (exit ${REFUSE_CODE})"
  printf '%s\n' "$OUT_REFUSE" | sed 's/^/      /'
  FAILURES=$((FAILURES + 1))
fi

echo "---- ${PASSES} passed, ${FAILURES} failed ----"
[ "$FAILURES" = "0" ]

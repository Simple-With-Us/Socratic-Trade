#!/usr/bin/env bash
# merge-shepherd must take --expected-actor on the CLI; no env fallback chain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${ROOT}/scripts/merge-shepherd.sh"

bash -n "$SCRIPT"

fail=0
grep -q 'EXPECTED_MERGE_ACTOR' "$SCRIPT" && {
  echo "FAIL merge-shepherd must not read EXPECTED_MERGE_ACTOR from env" >&2
  fail=1
}
grep -q 'SHEPHERD_EXPECTED_ACTOR' "$SCRIPT" && {
  echo "FAIL merge-shepherd must not read SHEPHERD_EXPECTED_ACTOR from env" >&2
  fail=1
}
grep -Eq 'ME="\$\{|ME="\$\(gh api user|ME="\$\{ME:-github-actions' "$SCRIPT" && {
  echo "FAIL merge-shepherd must not resolve actor via env, gh api, or default" >&2
  fail=1
}

if bash "$SCRIPT" 2>/dev/null; then
  echo "FAIL merge-shepherd must exit non-zero without --expected-actor" >&2
  fail=1
fi
if bash "$SCRIPT" --expected-actor 2>/dev/null; then
  echo "FAIL merge-shepherd must reject empty --expected-actor value" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "selftest: merge-shepherd expected-actor ok"

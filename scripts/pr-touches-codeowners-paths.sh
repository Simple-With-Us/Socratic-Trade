#!/usr/bin/env bash
# scripts/pr-touches-codeowners-paths.sh
#
# Returns whether a PR diff touches any path listed in .github/CODEOWNERS
# (trading-execution / live-money paths).  Used by auto-merge-prs.yml so those
# PRs are not auto-armed -- a human merges after review (board bdc2b662 / 318bfe710b794c28).
#
# Usage:
#   pr-touches-codeowners-paths.sh <base-sha> <head-sha>
#   pr-touches-codeowners-paths.sh --files <repo-relative-path>...
#
# Exit 0 when a protected path is touched (or when the diff cannot be computed -- fail closed).
# Exit 1 when no protected path is touched.
set -euo pipefail

CODEOWNERS_FILE="${CODEOWNERS_FILE:-.github/CODEOWNERS}"

usage() {
  echo "Usage: pr-touches-codeowners-paths.sh <base-sha> <head-sha>" >&2
  echo "   or: pr-touches-codeowners-paths.sh --files <path>..." >&2
  exit 2
}

# Match one changed file against one CODEOWNERS pattern (GitHub-style, repo-root relative).
file_matches_pattern() {
  local file="$1"
  local raw_pat="$2"
  local pat="${raw_pat#/}"
  pat="${pat%%@*}"
  pat="$(printf '%s' "$pat" | sed 's/[[:space:]]*$//')"
  [ -z "$pat" ] && return 1

  if [[ "$pat" == */ ]]; then
    local dir="${pat%/}"
    if [[ "$file" == "$dir" ]] || [[ "$file" == "$dir/"* ]]; then
      return 0
    fi
    return 1
  fi

  case "$file" in
    $pat) return 0 ;;
  esac
  return 1
}

load_patterns() {
  [ -f "$CODEOWNERS_FILE" ] || {
    echo "Missing $CODEOWNERS_FILE -- treating diff as protected (fail closed)" >&2
    return 1
  }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$line" ] && continue
    printf '%s\n' "$line"
  done < "$CODEOWNERS_FILE"
}

touches_protected() {
  local file="$1"
  local pat
  while IFS= read -r pat; do
    if file_matches_pattern "$file" "$pat"; then
      return 0
    fi
  done < <(load_patterns)
  return 1
}

check_files() {
  local file
  for file in "$@"; do
    [ -z "$file" ] && continue
    if touches_protected "$file"; then
      echo "Protected path touched: $file" >&2
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" = "--files" ]; then
  shift
  [ "$#" -gt 0 ] || usage
  if check_files "$@"; then
    exit 0
  fi
  exit 1
fi

[ "$#" -eq 2 ] || usage
BASE="$1"
HEAD="$2"

changed_files="$(git diff --name-only --no-renames "$BASE" "$HEAD" 2>/dev/null || true)"
if [ -z "$changed_files" ]; then
  echo "Could not compute changed-files list -- treating as protected (fail closed)" >&2
  exit 0
fi

while IFS= read -r file; do
  [ -z "$file" ] && continue
  if touches_protected "$file"; then
    echo "Protected path touched: $file" >&2
    exit 0
  fi
done <<< "$changed_files"

exit 1

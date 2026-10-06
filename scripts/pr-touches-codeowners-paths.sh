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

# PR commit range: merge-base(base, head)..head (not base..head tree diff).
pr_changed_files() {
  local base="$1"
  local head="$2"
  local merge_base
  merge_base="$(git merge-base "$base" "$head" 2>/dev/null || true)"
  if [ -z "$merge_base" ]; then
    return 1
  fi
  git diff --name-only --no-renames "$merge_base" "$head" 2>/dev/null || true
  return 0
}

# Match one changed file against one normalized CODEOWNERS pattern.
# $2 = anchored flag (1 = leading / in CODEOWNERS, 0 = match anywhere per GitHub rules)
# $3 = pattern without leading / and without @owners (normalized in load_patterns).
file_matches_pattern() {
  local file="$1"
  local anchored="$2"
  local pat="$3"
  [ -z "$pat" ] && return 1

  if [[ "$pat" == */ ]]; then
    local dir="${pat%/}"
    if [ "$anchored" = 1 ]; then
      if [[ "$file" == "$dir" ]] || [[ "$file" == "$dir/"* ]]; then
        return 0
      fi
      return 1
    fi
    if [[ "$file" == "$dir" ]] || [[ "$file" == "$dir/"* ]]; then
      return 0
    fi
    if [[ "$file" == */"$dir" ]] || [[ "$file" == */"$dir/"* ]]; then
      return 0
    fi
    return 1
  fi

  if [ "$anchored" = 1 ]; then
    case "$file" in
      $pat) return 0 ;;
    esac
    return 1
  fi

  # Slash-less unanchored patterns: basename at any directory depth (GitHub CODEOWNERS).
  if [[ "$pat" != */* ]]; then
    local base="${file##*/}"
    case "$base" in
      $pat) return 0 ;;
    esac
    return 1
  fi

  # Unanchored path pattern (contains / but no leading /): match anywhere in the tree.
  case "$file" in
    $pat | */$pat) return 0 ;;
  esac
  return 1
}

# Prints one normalized pattern per line: "<anchored>\t<pattern>" (no subprocesses per line).
load_patterns() {
  [ -f "$CODEOWNERS_FILE" ] || {
    echo "Missing $CODEOWNERS_FILE -- treating diff as protected (fail closed)" >&2
    return 1
  }
  local line pat anchored
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue

    anchored=0
    pat="$line"
    if [[ "$pat" == /* ]]; then
      anchored=1
      pat="${pat#/}"
    fi
    pat="${pat%%@*}"
    pat="${pat#"${pat%%[![:space:]]*}"}"
    pat="${pat%"${pat##*[![:space:]]}"}"
    [ -z "$pat" ] && continue
    printf '%s\t%s\n' "$anchored" "$pat"
  done < "$CODEOWNERS_FILE"
}

load_patterns_into_array() {
  local -n _out=$1
  _out=()
  local row anchored pat
  while IFS=$'\t' read -r anchored pat || [ -n "$anchored" ]; do
    [ -z "$anchored" ] && continue
    _out+=("$anchored" "$pat")
  done < <(load_patterns) || return 1
  return 0
}

file_touches_patterns() {
  local file="$1"
  shift
  local -a pairs=("$@")
  local i anchored pat
  for ((i = 0; i < ${#pairs[@]}; i += 2)); do
    anchored="${pairs[i]}"
    pat="${pairs[i + 1]}"
    if file_matches_pattern "$file" "$anchored" "$pat"; then
      return 0
    fi
  done
  return 1
}

check_files_against_patterns() {
  local pattern_pairs=()
  load_patterns_into_array pattern_pairs || return 0

  local file
  for file in "$@"; do
    [ -z "$file" ] && continue
    if file_touches_patterns "$file" "${pattern_pairs[@]}"; then
      echo "Protected path touched: $file" >&2
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" = "--files" ]; then
  shift
  [ "$#" -gt 0 ] || usage
  if check_files_against_patterns "$@"; then
    exit 0
  fi
  exit 1
fi

[ "$#" -eq 2 ] || usage
BASE="$1"
HEAD="$2"

changed_files="$(pr_changed_files "$BASE" "$HEAD" || true)"
if [ -z "$changed_files" ]; then
  echo "Could not compute PR changed-files list -- treating as protected (fail closed)" >&2
  exit 0
fi

pattern_pairs=()
load_patterns_into_array pattern_pairs || exit 0

while IFS= read -r file; do
  [ -z "$file" ] && continue
  if file_touches_patterns "$file" "${pattern_pairs[@]}"; then
    echo "Protected path touched: $file" >&2
    exit 0
  fi
done <<< "$changed_files"

exit 1

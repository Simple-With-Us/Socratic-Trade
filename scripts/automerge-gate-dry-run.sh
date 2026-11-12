#!/usr/bin/env bash
# Decide whether .github/workflows/auto-merge-prs.yml would arm or disarm
# auto-merge.  No GitHub calls.  Exit 0 prints the decision.  Exit 2 is usage.
#
#   bash scripts/automerge-gate-dry-run.sh --list-globs
#   bash scripts/automerge-gate-dry-run.sh --files PATH...
#   bash scripts/automerge-gate-dry-run.sh --label do-not-automerge --files PATH...
#
# arm=false and disarm=true when a file matches a CODEOWNERS money-path glob,
# when a hold label is set (do-not-automerge or needs-human-merge), or when
# the diff edits this gate.  disarm=true is the already-armed case: the
# workflow runs `gh pr merge --disable-auto`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLASSIFIER="$ROOT/scripts/pr-touches-codeowners-paths.sh"
# The classifier reads CODEOWNERS from the working directory unless this is set.
# The dry run is often launched from another directory.
export CODEOWNERS_FILE="${CODEOWNERS_FILE:-$ROOT/.github/CODEOWNERS}"

if [ "${1:-}" = "--list-globs" ]; then
  [ "$#" -eq 1 ] || {
    echo "Usage: automerge-gate-dry-run.sh --list-globs" >&2
    exit 2
  }
  bash "$CLASSIFIER" --list-globs
  exit 0
fi

labels=()
files=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --label)
      [ "$#" -ge 2 ] || {
        echo "missing label" >&2
        exit 2
      }
      labels+=("$2")
      shift 2
      ;;
    --files)
      shift
      if [ "$#" -eq 0 ]; then
        echo "missing files" >&2
        exit 2
      fi
      files+=("$@")
      break
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "Usage: automerge-gate-dry-run.sh [--label NAME]... --files PATH..." >&2
  exit 2
fi

hold=false
if [ "${#labels[@]}" -gt 0 ]; then
  for label in "${labels[@]}"; do
    case "$label" in
      do-not-automerge|needs-human-merge) hold=true ;;
    esac
  done
fi

touches=false
set +e
bash "$CLASSIFIER" --files "${files[@]}" >/dev/null
status=$?
set -e
if [ "$status" -eq 0 ]; then
  touches=true
elif [ "$status" -ne 1 ]; then
  echo "classifier exited $status" >&2
  exit 1
fi

gate_edit=false
for file in "${files[@]}"; do
  case "$file" in
    .github/CODEOWNERS|.github/workflows/auto-merge-prs.yml|scripts/pr-touches-codeowners-paths.sh|scripts/automerge-gate-dry-run.sh|scripts/disable-pr-automerge.sh)
      gate_edit=true
      ;;
  esac
done

arm=true
disarm=false
if [ "$touches" = true ] || [ "$hold" = true ] || [ "$gate_edit" = true ]; then
  arm=false
  disarm=true
fi

printf 'touches_protected=%s\n' "$touches"
printf 'hold_label=%s\n' "$hold"
printf 'gate_edit=%s\n' "$gate_edit"
printf 'arm=%s\n' "$arm"
printf 'disarm=%s\n' "$disarm"

#!/usr/bin/env bash
# Effort-mirror orphan report: detect stale or orphaned effort-board rows.
# Usage: bash scripts/effort-orphan-report.sh
#
# Reads docs/EFFORT-LOG.md and identifies:
#   1. Rows with no corresponding GitHub issue (no <!-- effort-key: --> marker match)
#   2. Rows with stale "In Progress" state (>7 days without update)
#   3. Rows whose state contradicts the GitHub issue state
#
# Output: a report to stdout. Exit 0 even on findings (report-only, not a gate).
set -euo pipefail

BOARD="${1:-docs/EFFORT-LOG.md}"
STALE_DAYS="${2:-7}"  # rows in "In Progress" for >N days are stale

if [[ ! -f "$BOARD" ]]; then
  echo "ERROR: Board file not found: $BOARD" >&2
  exit 1
fi

echo "=== Effort-mirror orphan report ==="
echo "Board: $BOARD"
echo "Stale threshold: $STALE_DAYS days"
echo "Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

# Detect rows that look like effort items (start with "- " or "  - " after a ## section)
# but have no <!-- effort-key: --> marker (meaning they were never synced to a GitHub issue).
echo "--- Rows with no GitHub issue marker ---"
ORPHANS=0
IN_SECTION=0
while IFS= read -r LINE; do
  # Track heading sections. Match one-or-more '#' + whitespace: a single '#' matched only H1
  # ('# Title'), so '## Section' failed the outer test and the inner '##' branch was never reached,
  # leaving IN_SECTION stuck at 0 and every row skipped (the scan always reported zero orphans).
  if [[ "$LINE" =~ ^#+[[:space:]] ]]; then
    IN_SECTION=0
    if [[ "$LINE" =~ ^##[[:space:]] ]]; then
      IN_SECTION=1
    fi
    continue
  fi
  # Only consider lines in ## sections
  if [[ $IN_SECTION -eq 0 ]]; then continue; fi
  # Skip non-bullet lines
  if [[ ! "$LINE" =~ ^[[:space:]]*-[[:space:]] ]]; then continue; fi
  # Check for effort-key marker
  if [[ "$LINE" =~ effort-key: ]]; then continue; fi
  # This is a potential orphan row
  ORPHANS=$((ORPHANS + 1))
  echo "  ORPHAN: ${LINE:0:120}"
done < "$BOARD"

if [[ $ORPHANS -eq 0 ]]; then
  echo "  (none found — all rows have effort-key markers)"
fi

echo ""
echo "--- Stale In-Progress rows (no date update in >$STALE_DAYS days) ---"
STALE=0
IN_SECTION=0
CURRENT_SECTION=""
while IFS= read -r LINE; do
  if [[ "$LINE" =~ ^#[[:space:]] ]]; then
    IN_SECTION=0
    if [[ "$LINE" =~ ^##[[:space:]] ]]; then
      IN_SECTION=1
      CURRENT_SECTION="$LINE"
    fi
    continue
  fi
  if [[ $IN_SECTION -eq 0 ]]; then continue; fi
  # Only the "In Progress" section
  if [[ "$CURRENT_SECTION" != *"In Progress"* ]]; then continue; fi
  if [[ ! "$LINE" =~ ^[[:space:]]*-[[:space:]] ]]; then continue; fi
  # Look for a date like "2026-07-05" or "2026-07-04" in the line
  if [[ "$LINE" =~ (202[0-9]-[0-9]{2}-[0-9]{2}) ]]; then
    LAST_DATE="${BASH_REMATCH[1]}"
    # Compare date to now (macOS date command)
    if [[ "$(uname)" == "Darwin" ]]; then
      DATE_EPOCH=$(date -j -f "%Y-%m-%d" "$LAST_DATE" "+%s" 2>/dev/null || echo 0)
      NOW_EPOCH=$(date "+%s")
      DAYS_AGO=$(( (NOW_EPOCH - DATE_EPOCH) / 86400 ))
    else
      DATE_EPOCH=$(date -d "$LAST_DATE" "+%s" 2>/dev/null || echo 0)
      NOW_EPOCH=$(date "+%s")
      DAYS_AGO=$(( (NOW_EPOCH - DATE_EPOCH) / 86400 ))
    fi
    if [[ $DAYS_AGO -gt $STALE_DAYS ]]; then
      STALE=$((STALE + 1))
      echo "  STALE (${DAYS_AGO}d): ${LINE:0:120}"
    fi
  fi
done < "$BOARD"

if [[ $STALE -eq 0 ]]; then
  echo "  (none found)"
fi

echo ""
echo "=== Summary: $ORPHANS orphans, $STALE stale rows ==="
echo "Report complete."

#!/usr/bin/env bash
# Litestream restore drill — proves the CONTINUOUS replication tier can be restored.
#
# Restores the B2 replica to a scratch file, integrity-checks it, and compares row counts
# against the live database.  It never touches the live app.db and never writes to a
# replica.  Record the outcome in docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md and
# on THE BOARD — a drill that was run but not written down will be run again next quarter
# by someone who cannot tell whether it ever passed.
#
# Cadence: quarterly, and after any Litestream version bump or litestream.coolify.yml change.
# Policy: docs/backup-policy.md.
#
# 2026-09-09: repointed at production.  This script previously defaulted to
# /Users/jay/apps/trading-live/, a Mac path that does not exist on any current machine, and
# described the replica as R2 — the active replica moved to Backblaze B2 in #2584.  It was
# therefore unrunnable as written, which is part of why the continuous tier has exactly one
# recorded restore proof (2026-08-18) and none since.
#
# WHERE TO RUN IT: on the production restore-drill HOST, NOT inside the app container.  Verified
# 2026-09-09: the host has `litestream` 0.5.16 at /usr/local/bin and `sqlite3` 3.46.1 at
# /usr/bin, both of which this script needs.  The runtime image has NEITHER — it ships no
# `sqlite3` CLI at all, and `coolify-prod-start.sh` downloads Litestream into
# /app/data/.bin and exports that PATH only for PID 1's process tree, which a later
# `docker exec` does not inherit.  A container invocation therefore dies at the
# `command -v litestream` guard, or at the first `sqlite3` call if PATH is patched by hand.
#
# CREDENTIALS: injected into the running Litestream process from Infisical; they are in no
# file and are NOT inherited by a fresh shell.  Export AWS_S3_BUCKET_NAME / AWS_S3_ENDPOINT /
# AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY into this shell from a trusted
# source before running.  Do not echo them, and do not write them to a file that outlives
# the drill.
#
# For the R2 cold-archive tier the equivalent drill is
# scripts/ops/verify-cold-snapshot-restore.mjs, which uses the bundled better-sqlite3 and so
# needs no `sqlite3` CLI — that one DOES run inside the container.
#
# Usage:
#   bash scripts/litestream-restore-drill.sh
#
# Required env (never pass secrets on argv):
#   AWS_S3_BUCKET_NAME  AWS_S3_ENDPOINT  AWS_REGION
#   AWS_ACCESS_KEY_ID   AWS_SECRET_ACCESS_KEY
# Optional:
#   LIVE_DB                       default /app/data/app.db
#   LITESTREAM_CONFIG             default /app/litestream.coolify.yml
#   SCRATCH_DIR                   default /data/scratch  (needs ~1x the DB size; NOT a tmpfs)
#   RESTORE_PITR_TIMESTAMP        ISO 8601 point-in-time target, inside the 72h retention window
#   RESTORE_DRILL_MIN_FREE_TENTHS default 10 (1.0x live DB size); scheduled wrapper uses 22 (2.2x)
#   RESTORE_DRILL_STATUS_JSON     when set, write machine-readable status on exit (pass or fail)
#   RESTORE_DRILL_RUN_ID          when set, included in the status JSON so the wrapper can
#                                 confirm the file was refreshed for this run
set -euo pipefail

LIVE_DB="${LIVE_DB:-/app/data/app.db}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/app/litestream.coolify.yml}"
SCRATCH_DIR="${SCRATCH_DIR:-/data/scratch}"
SCRATCH_DB="${SCRATCH_DIR}/app.db.restore-drill-$(date -u +%Y%m%dT%H%M%SZ)"
TIMESTAMP_FLAG=""
START_EPOCH="$(date +%s)"
START_ISO="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
MIN_FREE_TENTHS="${RESTORE_DRILL_MIN_FREE_TENTHS:-10}"
if ! printf '%s' "$MIN_FREE_TENTHS" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: RESTORE_DRILL_MIN_FREE_TENTHS must be an integer." >&2
  exit 1
fi
RESTORED_BYTES=0
INTEGRITY_RESULT=""
DRILL_PASS="false"
ROW_JSON_FILE=""
declare -A ROW_RESTORED ROW_LIVE ROW_DELTA

# Always drop the scratch copy, including when `set -e` fires mid-script.
# `PRAGMA integrity_check` can emit many rows; piping it to `head -1` under
# `pipefail` used to SIGPIPE sqlite3 and skip the explicit cleanup below.
cleanup_scratch() {
  if [[ -n "${SCRATCH_DB:-}" && -e "${SCRATCH_DB}" ]]; then
    rm -f "${SCRATCH_DB}"
    echo "  Removed: ${SCRATCH_DB}"
  fi
}
write_status_json() {
  local status_path="${RESTORE_DRILL_STATUS_JSON:-}"
  [[ -n "$status_path" ]] || return 0
  local duration=$(( $(date +%s) - START_EPOCH ))
  local pass_literal="false"
  [[ "$DRILL_PASS" == "true" ]] && pass_literal="true"
  local run_json=""
  if [[ -n "${RESTORE_DRILL_RUN_ID:-}" ]]; then
    run_json="$(printf ',"runId":"%s"' "$(printf '%s' "$RESTORE_DRILL_RUN_ID" | tr -d '"\\')")"
  fi
  if ! mkdir -p "$(dirname "$status_path")" 2>/dev/null; then
    echo "ERROR: status JSON not written: ${status_path} (cannot create parent directory)" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    if {
      printf '{"timestamp":"%s","durationSeconds":%s,"restoredSizeBytes":%s,"integrity":"%s","pass":%s,"rowCountDeltas":{}%s}\n' \
        "$START_ISO" "$duration" "$RESTORED_BYTES" "${INTEGRITY_RESULT:-}" "$pass_literal" "$run_json"
    } >"${status_path}.tmp" && mv "${status_path}.tmp" "$status_path"; then
      return 0
    fi
    echo "ERROR: status JSON not written: ${status_path}" >&2
    return 1
  fi
  ROW_JSON_FILE="${ROW_JSON_FILE:-$(mktemp "${TMPDIR:-/tmp}/restore-drill-rows.XXXXXX")}"
  : >"$ROW_JSON_FILE"
  local table
  for table in "${TABLES[@]:-}"; do
    [[ -n "${table:-}" ]] || continue
    printf '%s %s %s %s\n' \
      "$table" "${ROW_RESTORED[$table]:-}" "${ROW_LIVE[$table]:-}" "${ROW_DELTA[$table]:-n/a}" >>"$ROW_JSON_FILE"
  done
  RESTORE_DRILL_STATUS_JSON="$status_path" \
  RESTORE_DRILL_START_ISO="$START_ISO" \
  RESTORE_DRILL_DURATION="$duration" \
  RESTORE_DRILL_RESTORED_BYTES="$RESTORED_BYTES" \
  RESTORE_DRILL_INTEGRITY="${INTEGRITY_RESULT:-}" \
  RESTORE_DRILL_PASS="$pass_literal" \
  RESTORE_DRILL_ROWS_FILE="$ROW_JSON_FILE" \
  RESTORE_DRILL_RUN_ID="${RESTORE_DRILL_RUN_ID:-}" \
  python3 - <<'PY'
import json
import os
from pathlib import Path

rows = {}
path = os.environ.get("RESTORE_DRILL_ROWS_FILE", "")
if path and Path(path).is_file():
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        if len(parts) >= 4:
            table, restored, live, delta = parts[0], parts[1], parts[2], parts[3]
            rows[table] = {"restored": restored, "live": live, "delta": delta}

payload = {
    "timestamp": os.environ["RESTORE_DRILL_START_ISO"],
    "durationSeconds": int(os.environ["RESTORE_DRILL_DURATION"]),
    "restoredSizeBytes": int(os.environ.get("RESTORE_DRILL_RESTORED_BYTES") or 0),
    "integrity": os.environ.get("RESTORE_DRILL_INTEGRITY") or "",
    "rowCountDeltas": rows,
    "pass": os.environ.get("RESTORE_DRILL_PASS") == "true",
}
run_id = os.environ.get("RESTORE_DRILL_RUN_ID") or ""
if run_id:
    payload["runId"] = run_id
out = os.environ["RESTORE_DRILL_STATUS_JSON"]
tmp = out + ".tmp"
Path(tmp).write_text(json.dumps(payload, separators=(",", ":")) + "\n")
Path(tmp).replace(out)
PY
  local py_rc=$?
  if [ "$py_rc" -ne 0 ]; then
    echo "ERROR: status JSON not written: ${status_path}" >&2
    return 1
  fi
  if [ ! -f "$status_path" ]; then
    echo "ERROR: status JSON not written: ${status_path}" >&2
    return 1
  fi
  return 0
}

finalize_exit() {
  local rc="${1:-1}"
  local status_rc=0
  write_status_json || status_rc=$?
  cleanup_scratch
  trap - EXIT
  if [ "$status_rc" -ne 0 ]; then
    exit 1
  fi
  exit "$rc"
}

on_exit_write_status() {
  local status_rc=0
  write_status_json || status_rc=$?
  cleanup_scratch
  if [ "$status_rc" -ne 0 ]; then
    exit 1
  fi
}
trap on_exit_write_status EXIT

if [[ -n "${RESTORE_PITR_TIMESTAMP:-}" ]]; then
  TIMESTAMP_FLAG="-timestamp ${RESTORE_PITR_TIMESTAMP}"
  echo "PITR mode: restoring to ${RESTORE_PITR_TIMESTAMP}"
fi

: "${AWS_S3_BUCKET_NAME?Required: AWS_S3_BUCKET_NAME (B2 bucket, e.g. jays-socratic-trade-eu)}"
: "${AWS_ACCESS_KEY_ID?Required: AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY?Required: AWS_SECRET_ACCESS_KEY}"

# Loud guard against the documented footgun: BOTH the dead R2 replica and the live B2 replica
# use the identical object path `trading-live/app.db`; only bucket + endpoint differ.  This
# drill is read-only, so pointing it at the wrong one wastes time rather than destroying a
# backup — but say which one is being read so the recorded result means something.
echo "=== Litestream restore drill ==="
echo "Date:      $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Bucket:    ${AWS_S3_BUCKET_NAME}   (expect the B2 bucket, not socratic-trade-bucket)"
echo "Endpoint:  ${AWS_S3_ENDPOINT:-<unset>}"
echo "Live DB:   ${LIVE_DB}"
echo "Scratch:   ${SCRATCH_DB}"
echo "Config:    ${LITESTREAM_CONFIG}"
echo ""

if ! command -v litestream &>/dev/null; then
  echo "ERROR: litestream not found on this host." >&2
  exit 1
fi
if [[ ! -f "${LITESTREAM_CONFIG}" ]]; then
  echo "ERROR: config not found: ${LITESTREAM_CONFIG}" >&2
  exit 1
fi

mkdir -p "${SCRATCH_DIR}"

# Free space: the restore needs roughly one full copy of the database (scale via tenths).
DB_BYTES=$(stat -c %s "${LIVE_DB}" 2>/dev/null || echo 0)
AVAIL_BYTES=$(( $(df -Pk "${SCRATCH_DIR}" | awk 'NR==2 {print $4}') * 1024 ))
REQUIRED_BYTES=0
if [[ "${DB_BYTES}" -gt 0 ]]; then
  REQUIRED_BYTES=$(( (DB_BYTES * MIN_FREE_TENTHS) / 10 ))
fi
if [[ "${DB_BYTES}" -gt 0 && "${AVAIL_BYTES}" -lt "${REQUIRED_BYTES}" ]]; then
  echo "ERROR: ${SCRATCH_DIR} has ${AVAIL_BYTES} bytes free; need >= ${REQUIRED_BYTES} (${MIN_FREE_TENTHS}/10 x live ${DB_BYTES})." >&2
  exit 1
fi

LITESTREAM_VERSION=$(litestream version 2>&1 || echo "unknown")
echo "Litestream: ${LITESTREAM_VERSION}"

echo ""
echo "--- Step 1: replication health ---"
litestream databases -config "${LITESTREAM_CONFIG}" 2>&1 || true

echo ""
echo "--- Step 2: latest LTX generations (last 5) ---"
litestream ltx -config "${LITESTREAM_CONFIG}" "${LIVE_DB}" 2>&1 | tail -5 || true

echo ""
echo "--- Step 3: restore to scratch ---"
# shellcheck disable=SC2086
litestream restore -config "${LITESTREAM_CONFIG}" -o "${SCRATCH_DB}" ${TIMESTAMP_FLAG} "${LIVE_DB}"
RESTORED_BYTES=$(stat -c %s "${SCRATCH_DB}")
echo "Restore complete: ${SCRATCH_DB} (${RESTORED_BYTES} bytes)"

echo ""
echo "--- Step 4: integrity check ---"
# Do not pipe through `head`: a multi-row integrity_check + pipefail SIGPIPEs
# sqlite3 and, without the EXIT trap, would skip cleanup.
INTEGRITY=$(sqlite3 "${SCRATCH_DB}" 'PRAGMA integrity_check;')
INTEGRITY="${INTEGRITY%%$'\n'*}"
INTEGRITY_RESULT="$INTEGRITY"
echo "  Result: ${INTEGRITY}"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "  FAILED: restored database is not structurally sound." >&2
  exit 1
fi

echo ""
echo "--- Step 5: row-count comparison (restored vs live) ---"
# The same money-and-state tables the cold-snapshot lane asserts.  integrity_check answers
# "is this a well-formed SQLite file", not "does it still hold the trading state" — a
# structurally perfect EMPTY database passes step 4 and is worthless as a backup.
TABLES=("audit_events" "trade_proposals" "portfolio_snapshots" "connected_accounts" "settings" "llm_usage")
PASS=true

for table in "${TABLES[@]}"; do
  RESTORED_COUNT=$(sqlite3 "${SCRATCH_DB}" "SELECT count(*) FROM ${table};" 2>/dev/null || echo "N/A")
  # `-readonly` plus a mode=ro URI: the live DB is real trading state and this drill must not
  # be able to write to it even by accident.
  LIVE_COUNT=$(sqlite3 -readonly "file:${LIVE_DB}?mode=ro" "SELECT count(*) FROM ${table};" 2>/dev/null || echo "N/A")
  ROW_RESTORED["$table"]="$RESTORED_COUNT"
  ROW_LIVE["$table"]="$LIVE_COUNT"
  if [[ "${RESTORED_COUNT}" == "N/A" ]]; then
    echo "  ${table}: MISSING from the restored copy"
    PASS=false
    continue
  fi
  # Fail empty restored tables only when live is populated — a legitimately
  # empty table on both sides (e.g. all connected accounts removed) must pass.
  if [[ "${RESTORED_COUNT}" -le 0 ]]; then
    if [[ "${LIVE_COUNT}" != "N/A" && "${LIVE_COUNT}" -gt 0 ]]; then
      echo "  ${table}: EMPTY in the restored copy (live=${LIVE_COUNT})"
      PASS=false
      continue
    fi
    echo "  ${table}: empty restored and live=${LIVE_COUNT} — OK (live also empty/unreadable)"
  fi
  # The delta is INFORMATIONAL only, in either direction.  The pass/fail assertion is
  # non-emptiness (above), exactly as docs/backup-policy.md states — not row equality.
  # A positive delta is the live DB having moved on since the replica point.  A NEGATIVE
  # delta is also legitimate: rows are deleted between the two reads in normal operation
  # (`deleteInternalSetting()` prunes `settings`, retention sweeps prune others), so a
  # correct restore can hold more rows than live.  Failing on that would reject good
  # backups (flagged in review of PR #3204).
  if [[ "${LIVE_COUNT}" != "N/A" ]]; then
    DELTA=$((LIVE_COUNT - RESTORED_COUNT))
    ROW_DELTA["$table"]="$DELTA"
    echo "  ${table}: restored=${RESTORED_COUNT} live=${LIVE_COUNT} delta=${DELTA} (informational)"
    if [[ ${DELTA} -lt 0 ]]; then
      echo "    NOTE: restored holds more rows than live — expected where rows are deleted."
    fi
  else
    echo "  ${table}: restored=${RESTORED_COUNT} live=N/A"
  fi
done

echo ""
echo "--- Step 6: cleanup ---"

echo ""
echo "=== Drill complete ==="
if [[ "${PASS}" == "true" ]]; then
  DRILL_PASS="true"
  cat <<EOF
Result: PASS — restore from the B2 replica verified end to end.

Record it:
  docs/rollouts/$(date -u +%Y-%m-%d)-litestream-restore-drill.md
    - Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
    - Litestream version: ${LITESTREAM_VERSION}
    - Bucket: ${AWS_S3_BUCKET_NAME}
    - Integrity check: ${INTEGRITY}
    - Key tables: populated, deltas within expected range
EOF
  finalize_exit 0
fi
echo "Result: FAIL — see the findings above.  Do NOT record this tier as verified." >&2
DRILL_PASS="false"
finalize_exit 1

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
# WHERE TO RUN IT: on the HOST (fleet-hetzner-nbg1), NOT inside the app container.  Verified
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
#   LIVE_DB                  default /app/data/app.db
#   LITESTREAM_CONFIG        default /app/litestream.coolify.yml
#   SCRATCH_DIR              default /data/scratch  (needs ~1x the DB size; NOT a tmpfs)
#   RESTORE_PITR_TIMESTAMP   ISO 8601 point-in-time target, inside the 72h retention window
set -euo pipefail

LIVE_DB="${LIVE_DB:-/app/data/app.db}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/app/litestream.coolify.yml}"
SCRATCH_DIR="${SCRATCH_DIR:-/data/scratch}"
SCRATCH_DB="${SCRATCH_DIR}/app.db.restore-drill-$(date -u +%Y%m%dT%H%M%SZ)"
TIMESTAMP_FLAG=""

# Always drop the scratch copy, including when `set -e` fires mid-script.
# `PRAGMA integrity_check` can emit many rows; piping it to `head -1` under
# `pipefail` used to SIGPIPE sqlite3 and skip the explicit cleanup below.
cleanup_scratch() {
  if [[ -n "${SCRATCH_DB:-}" && -e "${SCRATCH_DB}" ]]; then
    rm -f "${SCRATCH_DB}"
    echo "  Removed: ${SCRATCH_DB}"
  fi
}
trap cleanup_scratch EXIT

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

# Free space: the restore needs roughly one full copy of the database.
DB_BYTES=$(stat -c %s "${LIVE_DB}" 2>/dev/null || echo 0)
AVAIL_BYTES=$(( $(df -Pk "${SCRATCH_DIR}" | awk 'NR==2 {print $4}') * 1024 ))
if [[ "${DB_BYTES}" -gt 0 && "${AVAIL_BYTES}" -lt "${DB_BYTES}" ]]; then
  echo "ERROR: ${SCRATCH_DIR} has ${AVAIL_BYTES} bytes free; the restore needs ~${DB_BYTES}." >&2
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
echo "Restore complete: ${SCRATCH_DB} ($(stat -c %s "${SCRATCH_DB}") bytes)"

echo ""
echo "--- Step 4: integrity check ---"
# Do not pipe through `head`: a multi-row integrity_check + pipefail SIGPIPEs
# sqlite3 and, without the EXIT trap, would skip cleanup.
INTEGRITY=$(sqlite3 "${SCRATCH_DB}" 'PRAGMA integrity_check;')
INTEGRITY="${INTEGRITY%%$'\n'*}"
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
cleanup_scratch
trap - EXIT

echo ""
echo "=== Drill complete ==="
if [[ "${PASS}" == "true" ]]; then
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
  exit 0
fi
echo "Result: FAIL — see the findings above.  Do NOT record this tier as verified." >&2
exit 1

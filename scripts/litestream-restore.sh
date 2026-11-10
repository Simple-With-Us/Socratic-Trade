#!/usr/bin/env bash
# Restore the trading-live SQLite DB from the Litestream R2 replica (Litestream 0.5.x).
# Usage: bash scripts/litestream-restore.sh [output-path]
#
# Required env vars (or have them in ~/apps/trading-live/.env.local):
#   AWS_S3_BUCKET_NAME, AWS_S3_ENDPOINT,
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Optional:
#   AWS_REGION  (default: auto, for Cloudflare R2)
set -euo pipefail

OUTPUT="${1:-/Users/jay/apps/trading-live/data/app.db.restored}"
CONFIG="${LITESTREAM_CONFIG:-/Users/jay/apps/trading-live/litestream.yml}"
DB="/Users/jay/apps/trading-live/data/app.db"

# Fall back to .env.local if the creds are not already exported.
if [[ -z "${AWS_S3_BUCKET_NAME:-}" && -f /Users/jay/apps/trading-live/.env.local ]]; then
  set -a
  eval "$(grep -E '^AWS_' /Users/jay/apps/trading-live/.env.local)"
  set +a
fi

: "${AWS_S3_BUCKET_NAME?Required: AWS_S3_BUCKET_NAME}"
: "${AWS_ACCESS_KEY_ID?Required: AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY?Required: AWS_SECRET_ACCESS_KEY}"

echo "Restoring latest backup to: $OUTPUT"
# 0.5.x: single replica, no -replica flag. Give the configured DB path; -o sets output.
litestream restore -config "$CONFIG" -o "$OUTPUT" "$DB"

echo ""
echo "Restore complete: $OUTPUT"
echo "Verify before swapping:"
echo "  sqlite3 \"$OUTPUT\" 'SELECT count(*) FROM audit_events;'"
echo ""
echo "To activate the restored file:"
echo "  pm2 stop trading"
echo "  cp \"$OUTPUT\" $DB"
echo "  pm2 restart trading"

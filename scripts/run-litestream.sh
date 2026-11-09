#!/usr/bin/env bash
# Durable Litestream launcher for PM2 (Litestream 0.5.x).
#
# Loads only LITESTREAM_* vars from .env.local via eval — NOT `source <(...)`,
# whose process substitution fails under PM2's stripped launch environment —
# then execs the replicator so PM2 supervises litestream directly.
#
# Deploy:
#   cp scripts/run-litestream.sh ~/apps/trading-live/run-litestream.sh
#   pm2 start ~/apps/trading-live/run-litestream.sh --name litestream --interpreter bash
#   pm2 save
set -a
eval "$(grep -E '^LITESTREAM_' /Users/jay/apps/trading-live/.env.local)"
set +a
exec /opt/homebrew/bin/litestream replicate -config /Users/jay/apps/trading-live/litestream.yml

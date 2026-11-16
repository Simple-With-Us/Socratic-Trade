#!/usr/bin/env bash
# Offline Litestream L1 delete-tool tests. No B2, R2, or rclone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
bash scripts/ops/litestream-l1-boundary-trim-fleet.selftest.sh

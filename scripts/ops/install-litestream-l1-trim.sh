#!/usr/bin/env bash
# Install the persistent L1 boundary-trim timer on fleet-hetzner-nbg1.
# Source of truth is this repo.  Idempotent.  Does not bounce Coolify.
# Does not FORCE_RESTORE.  Does not run the trim itself.
#
# Usage (from this repo, as root on the host):
#   bash scripts/ops/install-litestream-l1-trim.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_PY="$REPO_ROOT/scripts/litestream-l1-boundary-trim.py"
SRC_FLEET="$REPO_ROOT/scripts/ops/litestream-l1-boundary-trim-fleet.sh"
SRC_SERVICE="$REPO_ROOT/scripts/ops/litestream-l1-boundary-trim.service"
SRC_TIMER="$REPO_ROOT/scripts/ops/litestream-l1-boundary-trim.timer"

DST_PY="/usr/local/sbin/litestream-l1-boundary-trim"
DST_FLEET="/usr/local/sbin/litestream-l1-boundary-trim-fleet"
DST_SERVICE="/etc/systemd/system/litestream-l1-boundary-trim.service"
DST_TIMER="/etc/systemd/system/litestream-l1-boundary-trim.timer"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-litestream-l1-trim: must run as root on fleet-hetzner-nbg1" >&2
  exit 1
fi

for src in "$SRC_PY" "$SRC_FLEET" "$SRC_SERVICE" "$SRC_TIMER"; do
  if [ ! -f "$src" ]; then
    echo "install-litestream-l1-trim: missing $src" >&2
    exit 1
  fi
done

install -m 0755 "$SRC_PY" "$DST_PY"
install -m 0755 "$SRC_FLEET" "$DST_FLEET"
install -m 0644 "$SRC_SERVICE" "$DST_SERVICE"
install -m 0644 "$SRC_TIMER" "$DST_TIMER"

systemctl daemon-reload
systemctl enable --now litestream-l1-boundary-trim.timer
systemctl status --no-pager litestream-l1-boundary-trim.timer || true

echo "install-litestream-l1-trim: persistent timer enabled (OnCalendar 00:04 UTC)"
echo "install-litestream-l1-trim: did not start the oneshot service (next 00:04 UTC)"

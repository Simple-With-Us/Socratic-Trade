#!/usr/bin/env bash
# Start the Litestream restore-drill oneshot with notifications disabled, without
# patching /etc/default/st-litestream-restore-drill.
#
# Writes a non-persistent systemd runtime drop-in under /run/systemd/system/.
# /run is a tmpfs, so a reboot clears the override even if this shell is killed
# and the EXIT trap never runs.  The trap still removes the drop-in after a
# normal start so later weekly runs keep their usual notify setting.
#
# Usage (root, on the production restore-drill host):
#   bash scripts/ops/st-litestream-restore-drill-start-notify-off.sh
#   # or, once installed:
#   /usr/local/sbin/st-litestream-restore-drill-start-notify-off.sh
set -euo pipefail

UNIT="st-litestream-restore-drill.service"
DROP_DIR="/run/systemd/system/${UNIT}.d"
DROP_FILE="${DROP_DIR}/notify-off.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "st-litestream-restore-drill-start-notify-off: must run as root" >&2
  exit 1
fi

cleanup_dropin() {
  rm -f -- "$DROP_FILE"
  rmdir -- "$DROP_DIR" 2>/dev/null || true
  systemctl daemon-reload
}

trap cleanup_dropin EXIT

mkdir -p -- "$DROP_DIR"
cat >"$DROP_FILE" <<'UNIT'
[Service]
Environment=ST_RESTORE_DRILL_NOTIFY=0
UNIT
systemctl daemon-reload
systemctl start "$UNIT"

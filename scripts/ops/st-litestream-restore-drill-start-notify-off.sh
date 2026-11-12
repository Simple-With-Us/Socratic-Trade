#!/usr/bin/env bash
# Start the Litestream restore-drill oneshot with notifications disabled, without
# patching /etc/default/st-litestream-restore-drill.
#
# Writes a non-persistent systemd runtime drop-in under /run/systemd/system/.
# The EXIT trap removes it after the start returns, and HUP/INT/TERM are routed
# through that trap.  A SIGKILL (or a host crash) cannot run the trap, so the
# override then stays in place, and later scheduled runs send no Sentry alert,
# until the operator runs this helper with --cleanup (or reruns it) or the host
# reboots (/run is a tmpfs).
#
# Usage (root, on the production restore-drill host):
#   bash scripts/ops/st-litestream-restore-drill-start-notify-off.sh
#   bash scripts/ops/st-litestream-restore-drill-start-notify-off.sh --cleanup
#   # or, once installed:
#   /usr/local/sbin/st-litestream-restore-drill-start-notify-off.sh [--cleanup]
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

if [ "${1:-}" = "--cleanup" ]; then
  # Recovery after a killed run: remove a leftover notify-off drop-in only.
  cleanup_dropin
  echo "st-litestream-restore-drill-start-notify-off: removed any leftover notify-off drop-in."
  exit 0
fi

trap cleanup_dropin EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p -- "$DROP_DIR"
cat >"$DROP_FILE" <<'UNIT'
[Service]
Environment=ST_RESTORE_DRILL_NOTIFY=0
UNIT
systemctl daemon-reload
systemctl start "$UNIT"

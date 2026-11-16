#!/usr/bin/env bash
# Start the Litestream restore-drill oneshot with notifications disabled, without
# patching /etc/default/st-litestream-restore-drill.
#
# Writes a non-persistent systemd runtime drop-in under /run/systemd/system/.
# The drop-in replaces ExecStart with `/usr/bin/env ST_RESTORE_DRILL_NOTIFY=0
# <wrapper>`.  An `Environment=` line would not work: systemd lets values from
# EnvironmentFile= (/etc/default/st-litestream-restore-drill, which ships
# ST_RESTORE_DRILL_NOTIFY=1) override Environment=.  env(1) sets the variable at
# exec time, after systemd builds the environment, and the wrapper keeps a
# process-environment value over the env file.
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
# Must match ExecStart in scripts/ops/st-litestream-restore-drill.service (the
# selftest checks they agree).
WRAPPER="/usr/local/sbin/st-litestream-restore-drill.sh"
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
cat >"$DROP_FILE" <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/env ST_RESTORE_DRILL_NOTIFY=0 ${WRAPPER}
UNIT
systemctl daemon-reload
systemctl start "$UNIT"

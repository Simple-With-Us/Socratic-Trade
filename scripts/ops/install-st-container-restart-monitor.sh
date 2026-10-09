#!/usr/bin/env bash
# Install the ST container restart monitor on the fleet Hetzner host.
# Source of truth is this repo.  Idempotent.  Does not bounce Coolify or ST.
#
# Prerequisites on the host (owner):
#   - /etc/default/st-container-restart-monitor with notify env (see runbook).
#   - docker CLI for root (same as other fleet host scripts).
#
# Usage (from this repo, as root on the host):
#   bash scripts/ops/install-st-container-restart-monitor.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_SH="$REPO_ROOT/scripts/ops/st-container-restart-monitor.sh"
SRC_PY="$REPO_ROOT/scripts/ops/st-container-restart-monitor-sentry.py"
SRC_SERVICE="$REPO_ROOT/scripts/ops/st-container-restart-monitor.service"
SRC_TIMER="$REPO_ROOT/scripts/ops/st-container-restart-monitor.timer"
ENV_EXAMPLE="$REPO_ROOT/scripts/ops/st-container-restart-monitor.env.example"

DST_SH="/usr/local/sbin/st-container-restart-monitor.sh"
DST_PY="/usr/local/sbin/st-container-restart-monitor-sentry.py"
DST_SERVICE="/etc/systemd/system/st-container-restart-monitor.service"
DST_TIMER="/etc/systemd/system/st-container-restart-monitor.timer"
DST_ENV="/etc/default/st-container-restart-monitor"
STATE_DIR="/var/lib/st-container-restart-monitor"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-st-container-restart-monitor: must run as root on the fleet Hetzner host" >&2
  exit 1
fi

for src in "$SRC_SH" "$SRC_PY" "$SRC_SERVICE" "$SRC_TIMER" "$ENV_EXAMPLE"; do
  if [ ! -f "$src" ]; then
    echo "install-st-container-restart-monitor: missing $src" >&2
    exit 1
  fi
done

install -m 0755 "$SRC_SH" "$DST_SH"
install -m 0755 "$SRC_PY" "$DST_PY"
install -m 0644 "$SRC_SERVICE" "$DST_SERVICE"
install -m 0644 "$SRC_TIMER" "$DST_TIMER"
mkdir -p "$STATE_DIR"
chmod 0750 "$STATE_DIR"

if [ ! -f "$DST_ENV" ]; then
  install -m 0640 "$ENV_EXAMPLE" "$DST_ENV"
  echo "install-st-container-restart-monitor: created ${DST_ENV} from example - set ST_RESTART_MONITOR_COOLIFY_ID and fill secrets before the timer can page."
else
  echo "install-st-container-restart-monitor: kept existing ${DST_ENV}."
fi

systemctl daemon-reload
systemctl enable --now st-container-restart-monitor.timer
systemctl status --no-pager st-container-restart-monitor.timer || true

echo "install-st-container-restart-monitor: timer enabled (every ~15m at :02/:17/:32/:47)."
echo "install-st-container-restart-monitor: dry-run once with notify off:"
echo "  ST_RESTART_MONITOR_NOTIFY=0 ${DST_SH}"

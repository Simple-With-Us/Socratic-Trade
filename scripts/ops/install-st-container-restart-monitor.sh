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
#
# Host check: refuses unless `hostname` (short or full) equals the expected host
# or the expected host's short name (so an FQDN expected host matches a short
# `hostname`).  ST_INSTALL_EXPECTED_HOST or --expected-host NAME, default
# fleet-hetzner-nbg1.  --skip-host-check is the last-resort override (for
# example a rebuilt host).
set -euo pipefail

EXPECTED_HOST="${ST_INSTALL_EXPECTED_HOST:-fleet-hetzner-nbg1}"
SKIP_HOST_CHECK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-host)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "install-st-container-restart-monitor: --expected-host needs a host name" >&2
        exit 2
      fi
      EXPECTED_HOST="$2"
      shift 2
      ;;
    --expected-host=*)
      EXPECTED_HOST="${1#--expected-host=}"
      shift
      ;;
    --skip-host-check)
      SKIP_HOST_CHECK=1
      shift
      ;;
    *)
      echo "install-st-container-restart-monitor: unknown argument $1 (accepted: --expected-host NAME, --skip-host-check)" >&2
      exit 2
      ;;
  esac
done

if [ "$SKIP_HOST_CHECK" = 1 ]; then
  echo "install-st-container-restart-monitor: WARNING host check skipped (--skip-host-check)" >&2
else
  HOST_FULL="$(hostname 2>/dev/null || true)"
  HOST_SHORT="${HOST_FULL%%.*}"
  EXPECTED_SHORT="${EXPECTED_HOST%%.*}"
  if [ -z "$EXPECTED_HOST" ] || { [ "$HOST_FULL" != "$EXPECTED_HOST" ] && [ "$HOST_SHORT" != "$EXPECTED_HOST" ] && [ "$HOST_SHORT" != "$EXPECTED_SHORT" ]; }; then
    echo "install-st-container-restart-monitor: refusing to install on host '${HOST_FULL:-unknown}' (expected '${EXPECTED_HOST}').  Set ST_INSTALL_EXPECTED_HOST or pass --expected-host NAME for a renamed host, or --skip-host-check to override.  Nothing changed." >&2
    exit 1
  fi
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_SH="$REPO_ROOT/scripts/ops/st-container-restart-monitor.sh"
SRC_PY="$REPO_ROOT/scripts/ops/st-container-restart-monitor-sentry.py"
SRC_CHECKIN="$REPO_ROOT/scripts/ops/sentry-cron-checkin.py"
SRC_SERVICE="$REPO_ROOT/scripts/ops/st-container-restart-monitor.service"
SRC_TIMER="$REPO_ROOT/scripts/ops/st-container-restart-monitor.timer"
ENV_EXAMPLE="$REPO_ROOT/scripts/ops/st-container-restart-monitor.env.example"
CRON_ENV_EXAMPLE="$REPO_ROOT/scripts/ops/st-host-cron-sentry.env.example"

DST_SH="/usr/local/sbin/st-container-restart-monitor.sh"
DST_PY="/usr/local/sbin/st-container-restart-monitor-sentry.py"
DST_CHECKIN="/usr/local/sbin/sentry-cron-checkin.py"
DST_SERVICE="/etc/systemd/system/st-container-restart-monitor.service"
DST_TIMER="/etc/systemd/system/st-container-restart-monitor.timer"
DST_ENV="/etc/default/st-container-restart-monitor"
DST_CRON_ENV="/etc/default/st-host-cron-sentry"
STATE_DIR="/var/lib/st-container-restart-monitor"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-st-container-restart-monitor: must run as root on the fleet Hetzner host" >&2
  exit 1
fi

for src in "$SRC_SH" "$SRC_PY" "$SRC_CHECKIN" "$SRC_SERVICE" "$SRC_TIMER" "$ENV_EXAMPLE" "$CRON_ENV_EXAMPLE"; do
  if [ ! -f "$src" ]; then
    echo "install-st-container-restart-monitor: missing $src" >&2
    exit 1
  fi
done

if [ ! -f "$DST_ENV" ]; then
  install -m 0640 "$ENV_EXAMPLE" "$DST_ENV"
  echo "install-st-container-restart-monitor: created ${DST_ENV} from example - set ST_RESTART_MONITOR_COOLIFY_ID and fill secrets before the timer can page."
else
  echo "install-st-container-restart-monitor: kept existing ${DST_ENV}."
fi

if [ ! -f "$DST_CRON_ENV" ]; then
  install -m 0600 "$CRON_ENV_EXAMPLE" "$DST_CRON_ENV"
  echo "install-st-container-restart-monitor: created ${DST_CRON_ENV} from example - set SENTRY_CRONS_DSN for dead-man Crons."
else
  echo "install-st-container-restart-monitor: kept existing ${DST_CRON_ENV}."
fi

# Crons preflight before any unit changes: the wrapper refuses to run the job
# (exit 78) without a DSN unless SENTRY_CRONS_DISABLED=1, so do not install a
# unit that would stop the monitor from running.
if ! python3 "$SRC_CHECKIN" --env-file "$DST_CRON_ENV" --env-file "$DST_ENV" check; then
  echo "install-st-container-restart-monitor: set SENTRY_CRONS_DSN in ${DST_CRON_ENV} (or SENTRY_CRONS_DISABLED=1 after pausing the Sentry monitor), then re-run.  No units changed." >&2
  exit 1
fi

install -m 0755 "$SRC_SH" "$DST_SH"
install -m 0755 "$SRC_PY" "$DST_PY"
install -m 0755 "$SRC_CHECKIN" "$DST_CHECKIN"
install -m 0644 "$SRC_SERVICE" "$DST_SERVICE"
install -m 0644 "$SRC_TIMER" "$DST_TIMER"
mkdir -p "$STATE_DIR"
chmod 0750 "$STATE_DIR"

systemctl daemon-reload
systemctl enable --now st-container-restart-monitor.timer
systemctl status --no-pager st-container-restart-monitor.timer || true

echo "install-st-container-restart-monitor: timer enabled (every ~15m at :02/:17/:32/:47)."
echo "install-st-container-restart-monitor: dry-run once with notify off:"
echo "  ST_RESTART_MONITOR_NOTIFY=0 ${DST_SH}"

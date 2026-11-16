#!/usr/bin/env bash
# Install the persistent L1 boundary-trim timer on fleet-hetzner-nbg1.
# Source of truth is this repo.  Idempotent.  Does not bounce Coolify.
# Does not FORCE_RESTORE.  Does not run the trim itself.
#
# Usage (from this repo, as root on the host):
#   bash scripts/ops/install-litestream-l1-trim.sh
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
        echo "install-litestream-l1-trim: --expected-host needs a host name" >&2
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
      echo "install-litestream-l1-trim: unknown argument $1 (accepted: --expected-host NAME, --skip-host-check)" >&2
      exit 2
      ;;
  esac
done

if [ "$SKIP_HOST_CHECK" = 1 ]; then
  echo "install-litestream-l1-trim: WARNING host check skipped (--skip-host-check)" >&2
else
  HOST_FULL="$(hostname 2>/dev/null || true)"
  HOST_SHORT="${HOST_FULL%%.*}"
  EXPECTED_SHORT="${EXPECTED_HOST%%.*}"
  if [ -z "$EXPECTED_HOST" ] || { [ "$HOST_FULL" != "$EXPECTED_HOST" ] && [ "$HOST_SHORT" != "$EXPECTED_HOST" ] && [ "$HOST_SHORT" != "$EXPECTED_SHORT" ]; }; then
    echo "install-litestream-l1-trim: refusing to install on host '${HOST_FULL:-unknown}' (expected '${EXPECTED_HOST}').  Set ST_INSTALL_EXPECTED_HOST or pass --expected-host NAME for a renamed host, or --skip-host-check to override.  Nothing changed." >&2
    exit 1
  fi
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_PY="$REPO_ROOT/scripts/litestream-l1-boundary-trim.py"
SRC_FLEET="$REPO_ROOT/scripts/ops/litestream-l1-boundary-trim-fleet.sh"
SRC_CHECKIN="$REPO_ROOT/scripts/ops/sentry-cron-checkin.py"
SRC_SERVICE="$REPO_ROOT/scripts/ops/litestream-l1-boundary-trim.service"
SRC_TIMER="$REPO_ROOT/scripts/ops/litestream-l1-boundary-trim.timer"
ENV_EXAMPLE="$REPO_ROOT/scripts/ops/st-host-cron-sentry.env.example"

DST_PY="/usr/local/sbin/litestream-l1-boundary-trim"
DST_FLEET="/usr/local/sbin/litestream-l1-boundary-trim-fleet"
DST_CHECKIN="/usr/local/sbin/sentry-cron-checkin.py"
DST_SERVICE="/etc/systemd/system/litestream-l1-boundary-trim.service"
DST_TIMER="/etc/systemd/system/litestream-l1-boundary-trim.timer"
DST_ENV="/etc/default/st-host-cron-sentry"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-litestream-l1-trim: must run as root on fleet-hetzner-nbg1" >&2
  exit 1
fi

for src in "$SRC_PY" "$SRC_FLEET" "$SRC_CHECKIN" "$SRC_SERVICE" "$SRC_TIMER" "$ENV_EXAMPLE"; do
  if [ ! -f "$src" ]; then
    echo "install-litestream-l1-trim: missing $src" >&2
    exit 1
  fi
done

if [ ! -f "$DST_ENV" ]; then
  install -m 0600 "$ENV_EXAMPLE" "$DST_ENV"
  echo "install-litestream-l1-trim: created ${DST_ENV} from example - set SENTRY_CRONS_DSN before the units can run."
else
  echo "install-litestream-l1-trim: kept existing ${DST_ENV}."
fi

# Crons preflight before any unit changes: the wrapper refuses to run the job
# (exit 78) without a DSN unless SENTRY_CRONS_DISABLED=1.
if ! python3 "$SRC_CHECKIN" --env-file "$DST_ENV" check; then
  echo "install-litestream-l1-trim: set SENTRY_CRONS_DSN in ${DST_ENV} (or SENTRY_CRONS_DISABLED=1 after pausing the Sentry monitor), then re-run.  No units changed." >&2
  exit 1
fi

install -m 0755 "$SRC_PY" "$DST_PY"
install -m 0755 "$SRC_FLEET" "$DST_FLEET"
install -m 0755 "$SRC_CHECKIN" "$DST_CHECKIN"
install -m 0644 "$SRC_SERVICE" "$DST_SERVICE"
install -m 0644 "$SRC_TIMER" "$DST_TIMER"

systemctl daemon-reload
systemctl enable --now litestream-l1-boundary-trim.timer
systemctl status --no-pager litestream-l1-boundary-trim.timer || true

echo "install-litestream-l1-trim: persistent timer enabled (OnCalendar 00:04 UTC)"
echo "install-litestream-l1-trim: did not start the oneshot service (next 00:04 UTC)"

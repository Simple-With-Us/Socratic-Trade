#!/usr/bin/env bash
# Install the ST Litestream B2 restore drill timer on the fleet Hetzner host.
# Source of truth is this repo.  Idempotent.  Does not touch the live app.db or Litestream.
#
# Usage (from this repo, as root on the host):
#   bash scripts/ops/install-st-litestream-restore-drill.sh
#   bash scripts/ops/install-st-litestream-restore-drill.sh --dry-run
#   bash scripts/ops/install-st-litestream-restore-drill.sh --uninstall
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_WRAP="$REPO_ROOT/scripts/ops/st-litestream-restore-drill.sh"
SRC_DRILL="$REPO_ROOT/scripts/litestream-restore-drill.sh"
SRC_SENTRY="$REPO_ROOT/scripts/ops/st-container-restart-monitor-sentry.py"
SRC_SENTRY_DRILL="$REPO_ROOT/scripts/ops/st-litestream-restore-drill-sentry.py"
SRC_SERVICE="$REPO_ROOT/scripts/ops/st-litestream-restore-drill.service"
SRC_TIMER="$REPO_ROOT/scripts/ops/st-litestream-restore-drill.timer"
SRC_NOTIFY_OFF="$REPO_ROOT/scripts/ops/st-litestream-restore-drill-start-notify-off.sh"
ENV_EXAMPLE="$REPO_ROOT/scripts/ops/st-litestream-restore-drill.env.example"

DST_WRAP="/usr/local/sbin/st-litestream-restore-drill.sh"
DST_DRILL="/usr/local/sbin/litestream-restore-drill.sh"
DST_SENTRY="/usr/local/sbin/st-container-restart-monitor-sentry.py"
DST_SENTRY_DRILL="/usr/local/sbin/st-litestream-restore-drill-sentry.py"
DST_NOTIFY_OFF="/usr/local/sbin/st-litestream-restore-drill-start-notify-off.sh"
DST_SERVICE="/etc/systemd/system/st-litestream-restore-drill.service"
DST_TIMER="/etc/systemd/system/st-litestream-restore-drill.timer"
DST_ENV="/etc/default/st-litestream-restore-drill"
STATE_DIR="/var/lib/st-ops"

DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] [--uninstall]"
      exit 0
      ;;
    *)
      echo "install-st-litestream-restore-drill: unknown arg ${arg}" >&2
      exit 1
      ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "dry-run: $*"
  else
    "$@"
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  echo "install-st-litestream-restore-drill: must run as root on the fleet Hetzner host" >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  run systemctl disable --now st-litestream-restore-drill.timer || true
  # Keep the shared container-restart-monitor helper; only the drill alias is ours to remove.
  run rm -f "$DST_SERVICE" "$DST_TIMER" "$DST_WRAP" "$DST_DRILL" "$DST_SENTRY_DRILL" "$DST_NOTIFY_OFF"
  run systemctl daemon-reload
  echo "install-st-litestream-restore-drill: timer removed (kept ${DST_ENV} if present)."
  exit 0
fi

for src in "$SRC_WRAP" "$SRC_DRILL" "$SRC_SENTRY" "$SRC_SENTRY_DRILL" "$SRC_NOTIFY_OFF" "$SRC_SERVICE" "$SRC_TIMER" "$ENV_EXAMPLE"; do
  if [ ! -f "$src" ]; then
    echo "install-st-litestream-restore-drill: missing $src" >&2
    exit 1
  fi
done

run install -m 0755 "$SRC_WRAP" "$DST_WRAP"
run install -m 0755 "$SRC_DRILL" "$DST_DRILL"
run install -m 0755 "$SRC_SENTRY" "$DST_SENTRY"
run install -m 0755 "$SRC_SENTRY_DRILL" "$DST_SENTRY_DRILL"
run install -m 0755 "$SRC_NOTIFY_OFF" "$DST_NOTIFY_OFF"
run install -m 0644 "$SRC_SERVICE" "$DST_SERVICE"
run install -m 0644 "$SRC_TIMER" "$DST_TIMER"
run mkdir -p "$STATE_DIR"
run chmod 0750 "$STATE_DIR"

# Strip leftover secret assignments from an existing env file without printing values.
strip_secrets_from_env_file() {
  local src="$1"
  local tmp
  tmp="$(mktemp)"
  # awk prints only kept lines; secret values never leave this rewrite.
  awk '
    BEGIN {
      skip["AWS_ACCESS_KEY_ID"]=1
      skip["AWS_SECRET_ACCESS_KEY"]=1
      skip["SENTRY_FLEET_DSN"]=1
      skip["INFISICAL_TOKEN"]=1
      skip["INFISICAL_CLIENT_ID"]=1
      skip["INFISICAL_CLIENT_SECRET"]=1
      skip["INFISICAL_ST_CLIENT_ID"]=1
      skip["INFISICAL_ST_CLIENT_SECRET"]=1
    }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
    {
      line=$0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      key=line
      sub(/=.*/, "", key)
      gsub(/[[:space:]]/, "", key)
      if (key in skip) next
      # Drop any `export ` prefix: the wrapper accepts bare KEY=VALUE only.
      print line
    }
  ' "$src" >"$tmp"
  if ! cmp -s "$src" "$tmp"; then
    cat "$tmp" >"$src"
    echo "install-st-litestream-restore-drill: removed leftover secret keys from ${src}; the scheduled drill reads them from Infisical via INFISICAL_TOKEN_FILE."
  fi
  rm -f "$tmp"
}

if [ ! -f "$DST_ENV" ]; then
  run install -m 0600 "$ENV_EXAMPLE" "$DST_ENV"
  echo "install-st-litestream-restore-drill: created ${DST_ENV} from example (mode 0600)."
  echo "install-st-litestream-restore-drill: set INFISICAL_TOKEN_FILE (mode 0600 service token), INFISICAL_PROJECT_ID, and confirm secret names before the timer can run."
else
  run chown root:root "$DST_ENV"
  run chmod 0600 "$DST_ENV"
  if [ "$DRY_RUN" -eq 0 ]; then
    strip_secrets_from_env_file "$DST_ENV"
    chown root:root "$DST_ENV"
    chmod 0600 "$DST_ENV"
  else
    echo "dry-run: would strip leftover secret keys from ${DST_ENV} if present"
  fi
  echo "install-st-litestream-restore-drill: kept existing ${DST_ENV} (owner root:root, mode 0600)."
fi

run systemctl daemon-reload
run systemctl enable --now st-litestream-restore-drill.timer
if [ "$DRY_RUN" -eq 0 ]; then
  systemctl status --no-pager st-litestream-restore-drill.timer || true
fi

echo "install-st-litestream-restore-drill: weekly Sunday ~04:00 UTC timer enabled (RandomizedDelaySec=3600)."
echo "install-st-litestream-restore-drill: put the Infisical service token in the file named by INFISICAL_TOKEN_FILE (mode 0600)."
echo "install-st-litestream-restore-drill: notify-disabled start (does not patch the env file):"
echo "  ${DST_NOTIFY_OFF}"

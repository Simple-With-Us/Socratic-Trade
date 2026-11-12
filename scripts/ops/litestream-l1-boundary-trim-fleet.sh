#!/usr/bin/env bash
# Sequential L1 boundary-trim across the three in-container fleet apps.
# Runs on fleet-hetzner-nbg1 via systemd, NOT inside the Coolify container.
# Does not bounce Coolify.  Does not FORCE_RESTORE.  Does not touch L0/L9.
set -euo pipefail

# No colon: an explicitly empty LITESTREAM_L1_TRIM_BIN stays empty and fails
# closed below (exit 127) instead of silently running the production binary.
TRIM="${LITESTREAM_L1_TRIM_BIN-/usr/local/sbin/litestream-l1-boundary-trim}"
# Snapshot freshness: scheduled units pass 6h so a late/failed nightly aborts
# instead of trimming to yesterday's boundary.
MAX_AGE_HOURS="${LITESTREAM_L1_TRIM_MAX_SNAPSHOT_AGE_HOURS:-6}"

# Dry-run unless the unit opts in. A hand run must not delete.
# 1 means pass --apply. Anything else is refused. Unset and 0 stay dry-run.
case "${LITESTREAM_L1_TRIM_APPLY-}" in
  ""|0) want_apply=0 ;;
  1) want_apply=1 ;;
  *)
    echo "litestream-l1-boundary-trim-fleet: LITESTREAM_L1_TRIM_APPLY must be 0, 1, or unset" >&2
    exit 2
    ;;
esac

if [ -z "$TRIM" ] || [ ! -x "$TRIM" ]; then
  echo "litestream-l1-boundary-trim-fleet: missing executable $TRIM" >&2
  exit 127
fi

# Sequential on purpose: the tool has no lock, and concurrent rclone against
# the same B2 account burns Class A/C and can collide on hide markers.
apps=(socratic congress usage-monitor)
rc=0
for app in "${apps[@]}"; do
  echo "litestream-l1-boundary-trim-fleet: starting app=$app"
  trim_args=(--app "$app" --max-snapshot-age-hours "$MAX_AGE_HOURS")
  if [ "$want_apply" = "1" ]; then
    trim_args+=(--apply)
  fi
  if ! "$TRIM" "${trim_args[@]}"; then
    echo "litestream-l1-boundary-trim-fleet: app=$app failed" >&2
    rc=1
  fi
done
exit "$rc"

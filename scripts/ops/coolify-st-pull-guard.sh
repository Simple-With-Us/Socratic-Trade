#!/usr/bin/env bash
# Coolify st-pull-guard: stop Coolify from pulling a locally-built ST image from a registry.
#
# WHY THIS EXISTS (2026-09-25 P0, board 2c6a6a53 / Linear ST-3707)
# ---------------------------------------------------------------
# Socratic-Trade and Usage Monitor use Coolify's Dockerfile build pack, so the image is
# BUILT ON THIS BOX and tagged `{application_uuid}:{commit}` -- no registry prefix and no
# copy in any registry. Docker resolves a bare name with no slash as
# `docker.io/library/<uuid>`, which cannot exist.
#
# WHERE THE PULL ACTUALLY CAME FROM -- read this before changing anything:
#
#   ST runs deploy_dockerfile_buildpack() (line 950), which does NOT call
#   pull_docker_compose_images().  That method is called only from
#   deploy_docker_compose_buildpack() (line 636) -- the `dockercompose` pack that
#   congress-trade uses.  The 2026-09-25 registry pull therefore came from
#   `docker compose up` ITSELF: its default pull_policy is `missing`, so an absent local
#   tag sends Compose to a registry, and because Coolify stops the old container first,
#   production is already down when the registry answers no (Traefik 503 "no available
#   server").  That is the 5.3 minute P0.
#
# So the two halves do different work, and only ONE of them matters for ST:
#
#   PATCH 2  generate_compose_file() emits `pull_policy: never` for a local-only tag.
#            THIS IS THE FIX THAT PROTECTS ST.  Verified live: ST's generated compose
#            carries `pull_policy: never`, and deploy #4587 completed under it with zero
#            pull/authorization errors.
#
#   PATCH 1  pull_docker_compose_images() returns early for the Dockerfile pack.
#            INERT today: that method is reached only from the dockercompose deploy path,
#            where build_pack is `dockercompose`, so this `dockerfile` condition cannot be
#            true there, and ST/UM never reach the method at all.  Kept as harmless
#            defence in depth; do not rely on it to protect any app.
#
# The guard applies two minimal patches to the vendor file:
#
#   PATCH 1  pull_docker_compose_images() returns early for the Dockerfile build pack
#            when no registry image is configured. Skipping is strictly safe: the pull
#            it skips either pulls nothing (image already local) or fails.
#
#   PATCH 2  The generated compose gains `pull_policy: never` for a local-only tag: the
#            Dockerfile build pack, no configured registry image, and no `/` in the tag.
#            Compose can then never attempt a registry call for it.  Genuine Docker Hub
#            images (e.g. postgres:15-alpine in a dockerimage app) are left alone.
#            Verified effect: `docker compose pull` reports "Skipped" instead of
#            "Pulling ... pull access denied".
#
# DURABILITY -- READ THIS
# ----------------------
# This edits a VENDOR PHP FILE INSIDE THE `coolify` CONTAINER. It is wiped by any Coolify
# container recreate or upgrade. The 2026-10-15 scheduled upgrade to 4.4.6 FAILED on this
# box (containerd `lease does not exist`) and Coolify is still on 4.3.23, so that upgrade
# is still pending. Re-run `--apply` after ANY Coolify version change, and run `--verify`
# from the deploy-freshness watchdog if you want drift caught automatically.
#
# Usage (run ON the Hetzner box, as root):
#   scripts/ops/coolify-st-pull-guard.sh apply
#   scripts/ops/coolify-st-pull-guard.sh verify
#   scripts/ops/coolify-st-pull-guard.sh revert
#
# Exit status: 0 success / guard present, 1 usage error, 2 patch anchor not found,
# 3 php syntax check failed (live file NOT modified), 4 verify found the guard missing.

set -uo pipefail

CONTAINER="${COOLIFY_CONTAINER:-coolify}"
DB_CONTAINER="${COOLIFY_DB_CONTAINER:-coolify-db}"
REL_PATH="app/Jobs/ApplicationDeploymentJob.php"
LIVE="/var/www/html/$REL_PATH"
BACKUP="/var/www/html/$REL_PATH.mm-orig"
MARKER="MM-PATCH st-pull-guard"
SVC="/package/admin/s6/command/s6-svc"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

die() { echo "st-pull-guard: ERROR: $*" >&2; exit "${2:-1}"; }
info() { echo "st-pull-guard: $*" >&2; }

anchor_pull_old="    private function pull_docker_compose_images(): void
    {
        \$this->application_deployment_queue->addLogEntry('Pulling image-based services before stopping the current deployment.');
"

anchor_pull_new="    private function pull_docker_compose_images(): void
    {
        // MM-PATCH st-pull-guard: A Dockerfile build pack builds its image locally and
        // tags it {application_uuid}:{commit}, which has no copy in any registry. The
        // generated service has an \`image:\` key and NO \`build:\` key, so \`pull
        // --ignore-buildable\` does not skip it and Compose resolves the bare tag to
        // docker.io/library/{uuid} and fails. That failure used to be followed
        // unconditionally by stop_running_container(force: true), which took production
        // down (2026-09-25 P0, board 2c6a6a53). Skip the pull entirely unless an explicit
        // registry image is configured, in which case pulling is correct.
        if (\$this->application->build_pack === 'dockerfile' && ! data_get(\$this->application, 'docker_registry_image_name')) {
            \$this->application_deployment_queue->addLogEntry('Skipping image pull: Dockerfile build pack builds locally and this image has no registry copy.');

            return;
        }

        \$this->application_deployment_queue->addLogEntry('Pulling image-based services before stopping the current deployment.');
"

anchor_img_old="                    'image' => \$this->production_image_name,
"

anchor_img_new="                    'image' => \$this->production_image_name,
                    // MM-PATCH st-pull-guard: only a Dockerfile build pack that was NOT given a
                    // registry image produces Coolify's local-only {uuid}:{sha} tag, and only
                    // that tag has no '/'. An official image such as postgres:15-alpine also
                    // has no '/', so the build_pack + registry-name checks are what keep this
                    // from freezing a genuine Docker Hub pull in a dockerimage app.
                    ...(\$this->application->build_pack === 'dockerfile'
                        && ! data_get(\$this->application, 'docker_registry_image_name')
                        && ! str_contains(\$this->production_image_name, '/') ? ['pull_policy' => 'never'] : []),
"

# Writes the patching python to $work. Uses literal anchors supplied as files so no
# shell quoting can corrupt the PHP payload.
write_patcher() {
  cat > "$work/patch.py" <<'PYEOF'
import hashlib, pathlib, sys

target = pathlib.Path(sys.argv[1])
anchor_pull_old = pathlib.Path(sys.argv[2]).read_text()
anchor_pull_new = pathlib.Path(sys.argv[3]).read_text()
anchor_img_old = pathlib.Path(sys.argv[4]).read_text()
anchor_img_new = pathlib.Path(sys.argv[5]).read_text()

src = target.read_text()
print("pre-patch  sha256:", hashlib.sha256(src.encode()).hexdigest()[:16])

if "MM-PATCH st-pull-guard" in src:
    print("ALREADY PATCHED - no change made")
    sys.exit(0)

for name, anchor in (("pull guard", anchor_pull_old), ("pull_policy", anchor_img_old)):
    n = src.count(anchor)
    if n != 1:
        print("FATAL: anchor %r matched %d times (expected 1) - vendor file shape changed" % (name, n))
        sys.exit(2)

src = src.replace(anchor_pull_old, anchor_pull_new, 1).replace(anchor_img_old, anchor_img_new, 1)

if src.count("MM-PATCH st-pull-guard") != 2:
    print("FATAL: expected 2 patch markers")
    sys.exit(2)

target.write_text(src)
print("post-patch sha256:", hashlib.sha256(src.encode()).hexdigest()[:16])
print("PATCHED OK")
PYEOF
}

cmd_apply() {
  docker exec "$CONTAINER" test -f "$LIVE" || die "container $CONTAINER has no $LIVE" 1
  write_patcher
  printf '%s' "$anchor_pull_old" > "$work/a1"; printf '%s' "$anchor_pull_new" > "$work/a2"
  printf '%s' "$anchor_img_old"  > "$work/a3"; printf '%s' "$anchor_img_new"  > "$work/a4"

  docker cp "$CONTAINER:$LIVE" "$work/adj.php" || die "could not extract $LIVE" 1
  chmod 644 "$work/adj.php"

  if ! python3 "$work/patch.py" "$work/adj.php" "$work/a1" "$work/a2" "$work/a3" "$work/a4" > "$work/patch.out" 2>&1; then
    cat "$work/patch.out" >&2
    die "patching failed - live file untouched" 2
  fi
  cat "$work/patch.out" >&2

  # Already patched: do not reinstall the file or bounce the queue worker for nothing.
  if grep -q "ALREADY PATCHED" "$work/patch.out"; then
    info "guard already present - skipping install and horizon restart"
    echo
    cmd_verify
    return $?
  fi

  # Lint BEFORE touching the live file.
  docker cp "$work/adj.php" "$CONTAINER:/tmp/adj.patched.php" || die "staged copy failed" 1
  if ! docker exec "$CONTAINER" php -l /tmp/adj.patched.php; then
    docker exec -u 0 "$CONTAINER" rm -f /tmp/adj.patched.php
    die "php -l failed on patched file - live file NOT modified" 3
  fi
  docker exec -u 0 "$CONTAINER" rm -f /tmp/adj.patched.php

  docker exec "$CONTAINER" sh -c "cp -n $LIVE $BACKUP" || true
  docker cp "$work/adj.php" "$CONTAINER:$LIVE" || die "install failed" 1
  docker exec -u 0 "$CONTAINER" chown www-data:www-data "$LIVE"
  docker exec -u 0 "$CONTAINER" chmod 644 "$LIVE"
  info "installed (backup: $BACKUP)"

  # The job class is long-lived in the queue worker; reload it.
  if docker exec "$CONTAINER" "$SVC" -r /run/service/horizon; then
    info "signalled horizon restart"
    sleep 10
  else
    info "WARNING: could not restart horizon; restart it or the patch stays dormant"
  fi
  echo
  cmd_verify
}

cmd_verify() {
  local rc=0
  local n
  n="$(docker exec "$CONTAINER" grep -c "$MARKER" "$LIVE" 2>/dev/null | head -1)"
  n="${n:-0}"
  if [ "$n" = "2" ]; then
    echo "guard: PRESENT (2 patch markers)"
  else
    echo "guard: MISSING (found ${n} marker(s) in $LIVE)"
    rc=4
  fi

  if docker exec "$CONTAINER" php -l "$LIVE" >/dev/null 2>&1; then
    echo "php syntax: OK"
  else
    echo "php syntax: BROKEN"
    rc=1
  fi

  echo "worker reload:"
  docker exec "$CONTAINER" sh -c 'ps -eo args | grep -c "[h]orizon:work"' 2>/dev/null \
    | awk '{print ($1>0 ? "  horizon workers running: "$1 : "  WARNING: no horizon worker") }'

  echo "per application (PATCH 2 = pull_policy: never is what protects ST):"
  docker exec "$DB_CONTAINER" psql -U coolify -d coolify -tAF'|' -c \
    "SELECT id, name, build_pack, CASE WHEN build_pack='dockerfile' AND COALESCE(docker_registry_image_name,'')='' THEN 'pull_policy:never set (PATCH 2)' ELSE 'pull proceeds (unchanged)' END FROM applications ORDER BY id;" 2>/dev/null \
    | sed 's/^/  /'

  echo "worker age (the guard is dormant until the worker is newer than the last apply):"
  docker exec "$CONTAINER" sh -c 'ps -eo etimes,args | grep "[h]orizon:work" | head -1 | tr -s " " | cut -d" " -f2' 2>/dev/null \
    | awk '{ if ($1 ~ /^[0-9]+$/) print "  worker uptime_s="$1" (smaller = reloaded more recently)"; else print "  (could not read worker uptime)" }'
  return $rc
}

cmd_revert() {
  if ! docker exec "$CONTAINER" test -f "$BACKUP"; then
    die "no backup at $BACKUP - nothing to revert" 1
  fi
  # docker cp does NOT support container -> container. Round-trip through the host,
  # then prove the marker is actually gone instead of reporting a silent success.
  local tmp="$work/revert.php"
  docker cp "$CONTAINER:$BACKUP" "$tmp" || die "could not extract $BACKUP" 1
  docker cp "$tmp" "$CONTAINER:$LIVE" || die "restore failed" 1
  docker exec -u 0 "$CONTAINER" chown www-data:www-data "$LIVE"
  docker exec -u 0 "$CONTAINER" chmod 644 "$LIVE"

  local left
  left="$(docker exec "$CONTAINER" grep -c "$MARKER" "$LIVE" 2>/dev/null | head -1)"
  left="${left:-0}"
  if [ "$left" != "0" ]; then
    die "revert did not take: $left marker(s) still present in $LIVE" 1
  fi
  if ! docker exec "$CONTAINER" php -l "$LIVE" >/dev/null 2>&1; then
    die "restored file fails php -l" 3
  fi
  echo "revert: confirmed 0 markers in $LIVE, php syntax OK"
  docker exec "$CONTAINER" "$SVC" -r /run/service/horizon && info "reverted and horizon restarted"
}

case "${1:-}" in
  apply)  cmd_apply ;;
  verify) cmd_verify ;;
  revert) cmd_revert ;;
  *) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 1 ;;
esac
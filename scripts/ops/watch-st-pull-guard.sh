#!/usr/bin/env bash
# Watch for the next Dockerfile-build-pack deployment (ST id=1 or UM id=3) and report
# whether the st-pull-guard log line appears. Proves the guard fires end-to-end.
# Usage: /root/watch-guard.sh <max_minutes>
set -uo pipefail

MAX="${1:-25}"
DEADLINE=$(( $(date +%s) + MAX * 60 ))
SQL='SELECT id||E'\''|'\''||application_id||E'\''|'\''||status||E'\''|'\''||left(commit,10)
      FROM application_deployment_queues
      WHERE id > 4584 AND application_id IN (1,3)
      ORDER BY id DESC LIMIT 1;'
LOGSQL='SELECT logs FROM application_deployment_queues WHERE id = '

echo "watching up to ${MAX}m for an ST/UM deploy after id 4584..."
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  row="$(docker exec coolify-db psql -U coolify -d coolify -tAc "$SQL" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$row" ]; then
    id="$(echo "$row" | cut -d'|' -f1)"
    app="$(echo "$row" | cut -d'|' -f2)"
    st="$(echo "$row"  | cut -d'|' -f3)"
    sha="$(echo "$row" | cut -d'|' -f4)"
    case "$st" in
      finished|failed|cancelled*|error*)
        echo "deploy $id (app=$app $sha) -> $st"
        docker exec coolify-db psql -U coolify -d coolify -tAc "${LOGSQL}${id};" > "/tmp/d$id.log" 2>/dev/null
        if grep -q "Skipping image pull: Dockerfile build pack builds locally" "/tmp/d$id.log"; then
          echo "RESULT: GUARD FIRED (registry pull skipped) on deploy $id"
        else
          echo "RESULT: guard line NOT found on deploy $id"
        fi
        echo "--- the pull/stop window ---"
        grep -oE "Pulling image-based services before stopping the current deployment\.|Skipping image pull: Dockerfile build pack builds locally and this image has no registry copy\.|Removing old containers\.|Starting new application\.|New container started\." "/tmp/d$id.log" | head -8
        exit 0
        ;;
    esac
  fi
  sleep 25
done
echo "RESULT: no ST/UM deploy appeared within ${MAX}m"
exit 1
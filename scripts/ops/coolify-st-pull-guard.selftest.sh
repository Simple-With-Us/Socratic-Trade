#!/usr/bin/env bash
# Proves coolify-st-pull-guard.sh anchors still match a PRISTINE Coolify 4.3.23 file,
# i.e. the script would apply cleanly on a fresh box (not merely because the live file
# is already patched). It reconstructs the anchors by evaluating the guard script's own
# variable assignments verbatim, then patches a copy of the untouched .mm-orig backup.
#
# shellcheck disable=SC2154  # the anchor_* vars are assigned by sourcing extracted text
set -uo pipefail

SCRIPT="${1:-/root/coolify-st-pull-guard.sh}"
PRISTINE=/tmp/pristine.php

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

# The four anchor assignments are contiguous: from `anchor_pull_old=` through the
# closing quote of the last one (`anchor_img_new=`). Extract that block verbatim and
# eval it, so the anchors under test are byte-identical to what apply uses.
awk '/^anchor_pull_old=/{f=1} f{print} /^anchor_img_new=/{seen=1} seen && /^"$/{exit}' \
    "$SCRIPT" > "$W/anchors.sh"
if ! grep -q '^anchor_img_new=' "$W/anchors.sh"; then
  echo "TEST FAIL: could not extract the anchor block"; exit 1
fi
# shellcheck disable=SC1090
source "$W/anchors.sh"
for v in anchor_pull_old anchor_pull_new anchor_img_old anchor_img_new; do
  if [ -z "${!v}" ]; then echo "TEST FAIL: \$v empty after eval"; exit 1; fi
done
echo "anchors extracted: OK"

docker cp coolify:/var/www/html/app/Jobs/ApplicationDeploymentJob.php.mm-orig "$PRISTINE" || {
  echo "TEST FAIL: no pristine backup to test against"; exit 1; }
chmod 644 "$PRISTINE"
echo "pristine source bytes: $(wc -c < "$PRISTINE")"

if grep -q "MM-PATCH st-pull-guard" "$PRISTINE"; then
  echo "TEST FAIL: pristine file already contains the patch"; exit 1
fi

# shellcheck disable=SC2154  # anchors arrive via `source` of extracted assignments
printf '%s' "$anchor_pull_old" > "$W/a1"; printf '%s' "$anchor_pull_new" > "$W/a2"
printf '%s' "$anchor_img_old"  > "$W/a3"; printf '%s' "$anchor_img_new"  > "$W/a4"

# Reuse the guard script's own embedded patcher.
awk "/<<'PYEOF'/{f=1;next} /^PYEOF\$/{f=0} f" "$SCRIPT" > "$W/patch.py"
if [ ! -s "$W/patch.py" ]; then echo "TEST FAIL: could not extract patch.py"; exit 1; fi

python3 "$W/patch.py" "$PRISTINE" "$W/a1" "$W/a2" "$W/a3" "$W/a4" || {
  echo "TEST FAIL: patcher errored against the pristine file"; exit 1; }

n=$(grep -c "MM-PATCH st-pull-guard" "$PRISTINE")
echo "markers after patch: $n"
[ "$n" = "2" ] || { echo "TEST FAIL: expected 2 markers"; exit 1; }

docker cp "$PRISTINE" coolify:/tmp/pristine.patched.php >/dev/null
docker exec coolify php -l /tmp/pristine.patched.php || { echo "TEST FAIL: php -l failed"; exit 1; }
docker exec -u 0 coolify rm -f /tmp/pristine.patched.php

echo "PRISTINE-APPLY TEST PASSED"
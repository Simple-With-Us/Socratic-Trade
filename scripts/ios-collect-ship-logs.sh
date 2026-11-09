#!/usr/bin/env bash
# Collect TestFlight ship logs into one directory for a FAILED ios-ship run, so
# the archive/export/upload detail (and Xcode's .xcdistributionlogs, which never
# reach the job log) can be downloaded as an artifact.
#
# Usage: bash scripts/ios-collect-ship-logs.sh <out-dir>
#
# Safety, fail closed:
#   - values of ASC_KEY_ID, ASC_ISSUER_ID, SENTRY_DSN, SENTRY_AUTH_TOKEN (read
#     from the environment, never printed) are replaced with [REDACTED:<NAME>]
#     in every collected file
#   - if any collected file still contains "PRIVATE KEY", the whole directory is
#     deleted, "safe=0" is written to GITHUB_OUTPUT, and the script exits 1
# Writes "safe=1" to GITHUB_OUTPUT only after both passes succeed.
#
# ASCII-only (Apple bash 3.2 safe).
set +o xtrace
set -euo pipefail

out="${1:?usage: $0 <out-dir>}"
gh_out="${GITHUB_OUTPUT:-/dev/null}"
src="${IOS_SHIP_LOG_ROOT:-${TMPDIR:-/tmp}}"
src="${src%/}"

rm -rf "$out"
mkdir -p "$out"

n=0
for d in "$src"/ios-ship-*/logs; do
  [[ -d "$d" ]] || continue
  dest="${out}/$(basename "$(dirname "$d")")"
  mkdir -p "$dest"
  cp -R "$d"/. "$dest"/
  n=$((n + 1))
done
for d in "$src"/*.xcdistributionlogs; do
  [[ -d "$d" ]] || continue
  cp -R "$d" "$out"/
  n=$((n + 1))
done

if [[ "$n" -eq 0 ]]; then
  echo "[ship-logs] no ship logs under ${src}"
  echo "safe=0" >>"$gh_out"
  exit 0
fi

python3 - "$out" <<'PY'
import os, sys
names = ("ASC_KEY_ID", "ASC_ISSUER_ID", "SENTRY_DSN", "SENTRY_AUTH_TOKEN")
pairs = [(os.environ.get(n, "").encode(), ("[REDACTED:%s]" % n).encode()) for n in names]
pairs = [(v, r) for v, r in pairs if len(v) >= 4]
changed = 0
for root, _dirs, files in os.walk(sys.argv[1]):
    for f in files:
        p = os.path.join(root, f)
        if os.path.islink(p):
            os.unlink(p)
            continue
        with open(p, "rb") as h:
            data = h.read()
        new = data
        for v, r in pairs:
            new = new.replace(v, r)
        if new != data:
            with open(p, "wb") as h:
                h.write(new)
            changed += 1
print("[ship-logs] redacted known values in %d file(s)" % changed)
PY

if grep -rlaE 'PRIVATE KEY' "$out" >/dev/null 2>&1; then
  rm -rf "$out"
  echo "::error::ship logs contain key material; refusing to upload them as an artifact"
  echo "safe=0" >>"$gh_out"
  exit 1
fi

echo "[ship-logs] collected ${n} log dir(s) into ${out}"
echo "safe=1" >>"$gh_out"

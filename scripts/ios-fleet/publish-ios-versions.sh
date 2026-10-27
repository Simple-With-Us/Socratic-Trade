#!/usr/bin/env bash
# publish-ios-versions.sh — open a pull request that updates the public fleet
# iOS version manifest.
#
# Called by ship-testflight.sh after a successful upload.  Also safe to run by
# hand.  Never prints secret values.  Failure is non-fatal for ships.
#
# Usage:
#   bash scripts/ios-fleet/publish-ios-versions.sh \
#     --bundle-id com.socratictrade.ios \
#     --version 1.0.68 \
#     [--build 202608211800] \
#     [--apple-id 6799238379] \
#     [--display-name "Socratic-Trade"]
#     [--base-json path] [--out-json path] [--skip-push] [--skip-local-write]
#
# Writes:
#   <this-dir>/ios-app-versions.json  (local cache; may be stale)
#   a pull request against Simple-With-Us/AI-Fleet-Coordinator :
#     site/ios-versions.json
#
# WHY A PULL REQUEST AND NOT A DIRECT WRITE:  AI-Fleet-Coordinator's ruleset
# requires `test` and `gitleaks` on main, and a ruleset with required status
# checks refuses a direct write to the protected branch.  A Contents API PUT
# to the default branch is therefore rejected, the ship treats the publish as
# best effort, and the only trace anywhere is one warning line in the ship
# log.  A pull request merge is exempt from that gate, so the manifest is
# published as a branch plus a pull request.  The script never writes to the
# default branch.
#
# THE TOKEN:  the publish needs a credential with write access to
# AI-Fleet-Coordinator.  The ship workflow passes the fleet's GH_PAT secret
# as GH_TOKEN; a hand run uses whatever gh is already logged in as.  The
# workflow's own GITHUB_TOKEN is read-only by declaration and cannot write to
# another repository, so it is never used for this and never arms auto-merge.
#
# SAFETY: the vendored ios-app-versions.json in this repo is a stale snapshot
# (2026-08-21).  Starting from that file and publishing it would drop
# net.dealdex 1.0.2 and roll Usage Client 1.0.11→1.0.8, Usage Local
# 1.0.9→1.0.7, and Autorotate 1.0.4→1.0.1.  Always seed from the live remote
# (or an explicit --base-json).  Refuse to publish a single-app / empty-apps
# document over a multi-app remote.  Same class as DealDex #173.

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_JSON="${FLEET_DIR}/ios-app-versions.json"
REPO="${AFC_MANIFEST_REPO:-Simple-With-Us/AI-Fleet-Coordinator}"
REMOTE_PATH="site/ios-versions.json"
BASE_BRANCH="${AFC_MANIFEST_BRANCH:-main}"
PR_BRANCH_PREFIX="${AFC_MANIFEST_BRANCH_PREFIX:-ios-versions-publish}"
AUTO_MERGE="${AFC_MANIFEST_AUTO_MERGE:-1}"

BUNDLE_ID=""
VERSION=""
BUILD=""
APPLE_ID=""
DISPLAY_NAME=""
BASE_JSON=""
OUT_JSON=""
SKIP_PUSH=0
SKIP_LOCAL_WRITE=0

usage() {
  sed -n '1,45p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --apple-id) APPLE_ID="$2"; shift 2 ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    --base-json) BASE_JSON="$2"; shift 2 ;;
    --out-json) OUT_JSON="$2"; shift 2 ;;
    --skip-push) SKIP_PUSH=1; shift ;;
    --skip-local-write) SKIP_LOCAL_WRITE=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BUNDLE_ID" && -n "$VERSION" ]] || { echo "need --bundle-id and --version" >&2; exit 2; }

# Placeholder marketing/build values from --upload-only must never land in the
# public fleet manifest.  Auto-merge would otherwise publish "(from IPA)".
if [[ "$VERSION" == *"(from IPA)"* || "$BUILD" == *"(from IPA)"* ]]; then
  echo "error: refusing to publish placeholder version/build (${VERSION}${BUILD:+ / ${BUILD}})" >&2
  exit 1
fi

# The token the publish uses.  GITHUB_TOKEN is the workflow's own token:  it is
# read-only by declaration and it cannot write to another repository, so it is
# refused here rather than failing later with an authorization error that reads
# like a branch rule.
TOKEN=""
TOKEN_SOURCE=""
resolve_token() {
  # Approved sources only: process environment (fleet GH_PAT as GH_TOKEN).
  # Stored gh CLI credentials are outside the approved secret boundary.
  if [[ -n "${GH_TOKEN:-}" ]]; then
    TOKEN="$GH_TOKEN"
    TOKEN_SOURCE="env"
    return 0
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "error: GITHUB_TOKEN cannot write to ${REPO}" >&2
    echo "error: pass the fleet GH_PAT secret as GH_TOKEN (the ship workflow does)" >&2
    return 1
  fi
  echo "error: GH_TOKEN is required to publish the manifest (stored gh credentials are not an approved secret source)" >&2
  return 1
}

fetch_remote_json() {
  fetch_remote_json_at "$1" "$BASE_BRANCH"
}

fetch_remote_json_at() {
  local dest="$1"
  local ref="$2"
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi
  local b64
  b64="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}?ref=${ref}" --jq .content 2>/dev/null || true)"
  [[ -n "$b64" ]] || return 1
  python3 -c 'import base64,sys; sys.stdout.write(base64.b64decode("".join(sys.argv[1].split())).decode())' "$b64" >"$dest"
}

TMP_REMOTE=""
cleanup() {
  if [[ -n "${TMP_REMOTE}" && -f "${TMP_REMOTE}" ]]; then
    rm -f "${TMP_REMOTE}"
  fi
}
trap cleanup EXIT

BASE_SOURCE="explicit"
if [[ -z "$BASE_JSON" ]]; then
  TMP_REMOTE="$(mktemp)"
  if fetch_remote_json "$TMP_REMOTE"; then
    BASE_JSON="$TMP_REMOTE"
    BASE_SOURCE="remote"
  elif [[ -f "$LOCAL_JSON" ]]; then
    echo "warning: could not read the live manifest; seeding from the local snapshot ${LOCAL_JSON}" >&2
    echo "warning: a push from this stale seed is refused; use --skip-push for a local-only refresh" >&2
    BASE_JSON="$LOCAL_JSON"
    BASE_SOURCE="local"
  else
    echo "error: no remote ${REPO}/${REMOTE_PATH} and no local ${LOCAL_JSON}" >&2
    echo "error: refusing to publish an empty apps map (would wipe the fleet manifest)" >&2
    exit 1
  fi
fi

if [[ ! -f "$BASE_JSON" ]]; then
  echo "error: base json not found: ${BASE_JSON}" >&2
  exit 1
fi

MERGED="$(python3 - "$BASE_JSON" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys, datetime
path, bundle, version, build, apple_id, display = sys.argv[1:7]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    print("error: base json is not an object", file=sys.stderr)
    sys.exit(1)
apps = data.get("apps")
if not isinstance(apps, dict) or not apps:
    print("error: base json has no apps; refusing to publish a one-app replacement", file=sys.stderr)
    sys.exit(1)
before = set(apps)
entry = dict(apps.get(bundle) or {})
entry["marketingVersion"] = version
if build:
    entry["build"] = build
if apple_id:
    entry["appleId"] = int(apple_id)
if display:
    entry["displayName"] = display
apps[bundle] = entry
after = set(apps)
lost = sorted(before - after)
if lost:
    print("error: merge dropped apps: " + ", ".join(lost), file=sys.stderr)
    sys.exit(1)
if len(apps) < len(before) or (len(before) > 1 and len(apps) < 2):
    print("error: refusing to publish a one-app document over a multi-app remote", file=sys.stderr)
    sys.exit(1)
data["apps"] = apps
data["schemaVersion"] = 1
data["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(data, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
)"

# No-op check BEFORE any write to LOCAL_JSON.  When the remote fetch fails,
# BASE_JSON is the local snapshot path; writing MERGED onto that path first
# would make the comparison always match and silently skip every publish.
NEED_PUBLISH="$(python3 - "$BASE_JSON" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys
path, bundle, version, build, apple, display = sys.argv[1:]
entry = (json.load(open(path, encoding="utf-8")).get("apps") or {}).get(bundle) or {}
same = entry.get("marketingVersion") == version
for key, wanted in [("build", build), ("appleId", int(apple) if apple else None), ("displayName", display)]:
    if wanted is not None and wanted != "": same = same and entry.get(key) == wanted
print("0" if same else "1")
PY
)"
if [[ "$NEED_PUBLISH" -eq 0 ]]; then
  echo "version-manifest: ${BUNDLE_ID} ${VERSION}${BUILD:+ build ${BUILD}} is already recorded"
  # Preserve exact existing bytes and timestamp on a no-op.
  if [[ -n "$OUT_JSON" && "$OUT_JSON" != "$BASE_JSON" ]]; then cp "$BASE_JSON" "$OUT_JSON"; fi
  exit 0
fi

if [[ "$SKIP_PUSH" -eq 1 ]]; then
if [[ "$SKIP_LOCAL_WRITE" -eq 0 ]]; then
  printf '%s\n' "$MERGED" >"$LOCAL_JSON"
  echo "local-manifest-updated ${BUNDLE_ID} ${VERSION}"
fi
if [[ -n "$OUT_JSON" ]]; then
  printf '%s\n' "$MERGED" >"$OUT_JSON"
fi

  echo "skip-push ${BUNDLE_ID} ${VERSION} apps=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("apps") or {}))' <<<"$MERGED")"
  exit 0
fi

# A push seeded from the vendored local snapshot can drop fleet apps that the
# live manifest already carries.  Only --base-json (tests) or a live remote
# fetch may publish.
if [[ "$BASE_SOURCE" == "local" ]]; then
  echo "error: refusing to publish from the local snapshot; re-run when the live ${REPO}/${REMOTE_PATH} is readable" >&2
  exit 1
fi

# The credential is resolved before any API call, so a run that cannot
# possibly publish says why, instead of failing later on an authorization
# error that reads like a branch rule.
resolve_token || exit 1
if [[ -n "$TOKEN" ]]; then
  export GH_TOKEN="$TOKEN"
  unset GITHUB_TOKEN || true
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed; local manifest only" >&2
  exit 1
fi

PR_BRANCH="${PR_BRANCH_PREFIX}/$(printf '%s' "$BUNDLE_ID" | tr -c 'A-Za-z0-9._-' '-')"
PR_TITLE="chore: record ${BUNDLE_ID} ${VERSION} in the fleet iOS manifest"
# The gap between the sentences is a real no-break space plus a normal space,
# which is what GitHub renders.  The entity would show up literally.
SENTENCE_GAP=$'\xc2\xa0 '
PR_BODY="Automated fleet iOS version manifest update for ${BUNDLE_ID} ${VERSION}.${SENTENCE_GAP}Published by scripts/ios-fleet/publish-ios-versions.sh as a pull request, because AI-Fleet-Coordinator's ruleset refuses a direct write to main."

# 1.  The branch starts at the current default branch tip.
BASE_SHA="$(gh api "repos/${REPO}/git/ref/heads/${BASE_BRANCH}" --jq .object.sha)" || {
  echo "error: could not read ${REPO} ${BASE_BRANCH}" >&2
  exit 1
}
if gh api "repos/${REPO}/git/ref/heads/${PR_BRANCH}" >/dev/null 2>&1; then
  gh api --method PATCH "repos/${REPO}/git/refs/heads/${PR_BRANCH}" -f sha="$BASE_SHA" -F force=true >/dev/null
else
  gh api --method POST "repos/${REPO}/git/refs" -f ref="refs/heads/${PR_BRANCH}" -f sha="$BASE_SHA" >/dev/null
fi

# 2.  Re-seed from the manifest AT that tip and re-merge.  The earlier MERGED
#     document was built from a fetch that may predate commits that landed on
#     main between the first read and the branch cut; writing it onto a
#     branch cut from the newer tip would roll those siblings back.
TIP_JSON="$(mktemp)"
trap 'rm -f "${TIP_JSON}"; cleanup' EXIT
if ! fetch_remote_json_at "$TIP_JSON" "$BASE_SHA"; then
  echo "error: could not re-read ${REMOTE_PATH} at ${BASE_SHA}; refusing to publish a pre-branch snapshot" >&2
  exit 1
fi
MERGED="$(python3 - "$TIP_JSON" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys, datetime
path, bundle, version, build, apple_id, display = sys.argv[1:7]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    print("error: tip json is not an object", file=sys.stderr)
    sys.exit(1)
apps = data.get("apps")
if not isinstance(apps, dict) or not apps:
    print("error: tip json has no apps; refusing to publish a one-app replacement", file=sys.stderr)
    sys.exit(1)
before_count = len(apps)
entry = dict(apps.get(bundle) or {})
entry["marketingVersion"] = version
if build:
    entry["build"] = build
if apple_id:
    entry["appleId"] = int(apple_id)
if display:
    entry["displayName"] = display
apps[bundle] = entry
if len(apps) < before_count:
    print("error: merge dropped apps", file=sys.stderr)
    sys.exit(1)
if before_count > 1 and len(apps) < 2:
    print("error: refusing to publish a one-app document over a multi-app remote", file=sys.stderr)
    sys.exit(1)
data["apps"] = apps
data["schemaVersion"] = 1
data["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(data, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
)"

# The local/output artifact must equal the final re-seeded PR document.
if [[ "$SKIP_LOCAL_WRITE" -eq 0 ]]; then
  printf '%s\n' "$MERGED" >"$LOCAL_JSON"
  echo "local-manifest-updated ${BUNDLE_ID} ${VERSION}"
fi
if [[ -n "$OUT_JSON" ]]; then
  printf '%s\n' "$MERGED" >"$OUT_JSON"
fi


# 3.  The document lands on that branch, never on the default branch.
CONTENT_B64="$(printf '%s\n' "$MERGED" | python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())')"
FILE_SHA="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}?ref=${PR_BRANCH}" --jq .sha 2>/dev/null || true)"
PUT_ARGS=(
  --method PUT
  "repos/${REPO}/contents/${REMOTE_PATH}"
  -f message="chore: ${BUNDLE_ID} ${VERSION}"
  -f content="${CONTENT_B64}"
  -f branch="${PR_BRANCH}"
)
if [[ -n "$FILE_SHA" ]]; then
  PUT_ARGS+=(-f sha="$FILE_SHA")
fi
gh api "${PUT_ARGS[@]}" >/dev/null || {
  echo "error: version-manifest publish failed (branch ${PR_BRANCH})" >&2
  exit 1
}

# 4.  The pull request.  An open one for this branch is reused, so a fleet
#     that ships twice a day leaves one reviewable pull request, not a pile.
PR_NUMBER="$(gh api "repos/${REPO}/pulls?head=${REPO%%/*}:${PR_BRANCH}&state=open" --jq '.[0].number' 2>/dev/null || true)"
if [[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]]; then
  gh api --method PATCH "repos/${REPO}/pulls/${PR_NUMBER}" -f title="$PR_TITLE" -f body="$PR_BODY" >/dev/null
  PR_URL="https://github.com/${REPO}/pull/${PR_NUMBER}"
else
  PR_URL="$(gh api --method POST "repos/${REPO}/pulls" -f title="$PR_TITLE" -f body="$PR_BODY" -f head="$PR_BRANCH" -f base="$BASE_BRANCH" --jq .html_url)" || {
    echo "error: version-manifest publish failed (could not open the pull request)" >&2
    exit 1
  }
fi

# 5.  Arm the merge with the elevated env credential only.
if [[ "$AUTO_MERGE" == "1" && "$TOKEN_SOURCE" == "env" ]]; then
  PR_NUM="${PR_URL##*/}"
  if gh pr merge "$PR_NUM" --repo "$REPO" --squash --auto >/dev/null 2>&1; then
    echo "version-manifest: auto-merge armed on ${PR_URL}"
  else
    echo "version-manifest: auto-merge could not be armed on ${PR_URL}" >&2
  fi
fi

echo "version-manifest-pr ${PR_URL}"

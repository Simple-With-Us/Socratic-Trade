#!/usr/bin/env bash
# alert-deploy-freshness.sh - page when production is silently behind origin/main.
#
# 2026-08-06 class: five Coolify deploys died mid-build (SSH exec stream exit 255)
# while GitHub webhooks returned 200 and /api/health stayed green on the OLD sha.
# Nobody noticed for ~14h. verify-deploy-sha.sh is the post-merge assertion (it
# polls up to 25 min). This script is the standing watchdog: one probe, then
# decide whether the lag is still a legitimate in-flight build or a freeze.
#
# Predicate: the OLDEST commit on expected that is not an ancestor of live AND
# that can change the running image is older than STALE_SECONDS (default 3600).
# Tip-age alone is wrong - a second merge 10 min ago would hide a first merge
# that has been stuck for hours.  Ageing a commit that cannot change the image
# is just as wrong, and it was the false positive behind ST-4575: this script
# excluded only `docs`, so a CI-only commit counted as image-affecting and the
# watchdog paged on four consecutive runs while production was correctly still.
#
# It VERIFIES ONLY. It never triggers a deploy, never touches Coolify, and never
# posts a deploy claim. A stale verdict means investigate the webhook / build
# queue (see .claude/skills/deploy-verify/SKILL.md), not hand-deploy.
#
# Exit codes:
#   0  fresh enough (live contains expected, OR oldest image-affecting
#      undeployed commit is <1h, OR no commit in the gap can change the image)
#      Unreachable health is also 0 by default - UptimeRobot already pages
#      site-down; this watchdog is for the silent-green-on-old-sha class.
#   1  operational error (bad usage, missing git object, unexpected probe)
#   2  live release sha is null/absent
#   3  STALE: oldest undeployed commit is >= STALE_SECONDS old
#   4  live commit is divergent from expected
#   5  live commit id is not an object in this repo
#
# Usage:
#   bash scripts/alert-deploy-freshness.sh
#   bash scripts/alert-deploy-freshness.sh origin/main
#   DEPLOY_FRESHNESS_STALE_SECONDS=3600 bash scripts/alert-deploy-freshness.sh
#   DEPLOY_FRESHNESS_NOTIFY=1 bash scripts/alert-deploy-freshness.sh
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="${SCRIPT_DIR}/verify-deploy-sha.sh"
FLEET_POST="${SCRIPT_DIR}/agent-sync-fleet-post.sh"

HOST="${DEPLOY_VERIFY_HOST:-https://socratictrade.com}"
EXPECTED_REF="${1:-${DEPLOY_VERIFY_EXPECTED_SHA:-origin/main}}"
STALE_SECONDS="${DEPLOY_FRESHNESS_STALE_SECONDS:-3600}"
NOTIFY="${DEPLOY_FRESHNESS_NOTIFY:-0}"
# success|failure|none - previous cron tick, used to de-dupe optional Zulip pages.
PREVIOUS="${DEPLOY_FRESHNESS_PREVIOUS_CONCLUSION:-none}"
TREAT_UNREACHABLE_OK="${DEPLOY_FRESHNESS_TREAT_UNREACHABLE:-1}"
NO_FETCH="${DEPLOY_VERIFY_NO_FETCH:-0}"
CURL_TIMEOUT_SECONDS="${DEPLOY_VERIFY_CURL_TIMEOUT_SECONDS:-20}"

log() { printf '[deploy-freshness] %s\n' "$*" >&2; }

fail_usage() {
  log "error: $*"
  exit 1
}

[ -f "$VERIFY" ] || fail_usage "missing ${VERIFY}"
command -v git >/dev/null 2>&1 || fail_usage "git is required."
command -v jq >/dev/null 2>&1 || fail_usage "jq is required."
printf '%s' "$STALE_SECONDS" | grep -Eq '^[0-9]+$' || fail_usage "STALE_SECONDS must be an integer."
git rev-parse --git-dir >/dev/null 2>&1 || fail_usage "must run inside the Socratic-Trade git repo."

# Anchor to the repository root before any git call that names a path.  Git
# resolves a command-line pathspec against the current working directory, so a
# run started from a subdirectory resolves every WATCH_PATHS entry to
# <cwd>/<entry>, matches nothing, and drives the gap classification into the
# image-noop branch.  Git exits 0 with an empty list for a pathspec that
# matches nothing, so that run would report a fresh image-noop pass and the
# watchdog would be permanently silent - the exact failure class this script
# exists to detect.  The root is resolved once, here, and every later git call
# runs from it.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || fail_usage "cannot resolve the repository root."
cd "$REPO_ROOT"

resolve_commit() {
  git rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null || true
}

if [ "$NO_FETCH" != "1" ]; then
  git fetch --quiet origin >/dev/null 2>&1 || log "warn: git fetch origin failed - resolving against local refs only."
fi

EXPECTED_SHA="$(resolve_commit "$EXPECTED_REF")"
[ -n "$EXPECTED_SHA" ] || fail_usage "cannot resolve expected ref '${EXPECTED_REF}' to a commit in this repo."

# Coolify `watch_paths` on socratic-app is an ALLOW list: a push that touches
# none of these paths never creates a deployment, so no deployment is owed for
# it and the watchdog must not age it.  This mirrors
# COOLIFY_WATCH_PATHS_LIVE in src/lib/deploy-image-impact.ts, which records the
# live value; test/deploy-freshness-watch-paths.test.ts fails if the two drift.
# Do not PATCH the live list from a PR - it is applied out of band.
#
# A git pathspec names a directory and everything under it, so `src` covers
# `src/**` and `app` covers `app/**`, exactly as the live list pairs them.
WATCH_PATHS="Dockerfile .dockerignore package.json package-lock.json next.config.mjs postcss.config.mjs tsconfig.json middleware.ts instrumentation.ts instrumentation-client.ts sentry.server.config.ts sentry.edge.config.ts litestream.coolify.yml src app public scripts"

# This is the TRIGGER list, not the image-difference list.  The repo has a
# second list, isImageNoopPath in src/lib/deploy-image-impact.ts, which answers
# a different question:  "if a build happens, would the image differ?"  It
# treats docs/benchmarks as image-relevant, because Next imports those JSON
# files at build time.  The two lists differ on purpose and
# test/rth-deploy-latch.test.ts asserts both halves of the difference:
# docs/** is OMITTED from the trigger, so a push that touches only
# docs/benchmarks never creates a deployment and none is owed, while the
# build-time latch still refuses to skip a build that some other watched path
# triggered, because the benchmark JSON is in that image.  The watchdog asks
# whether a deployment was OWED, so it must use the trigger list.  Adding
# docs/benchmarks here would make it wait for a deployment Coolify never
# creates, which is the false-positive class ST-4575 removes.

# The gap between live and expected is classified below, once, against this
# list.  There is deliberately no separate "newest image-affecting commit"
# narrowing here any more: it used to compare production against a commit
# that may never deploy, and it excluded only `docs`, so every other
# non-runtime tree counted as image-affecting and the watchdog paged on CI
# commits (ST-4575).  One rule, applied to the whole gap: a deployment is owed
# only if some commit in the gap changed a watched path.
#
# `--first-parent` is load-bearing wherever the list is used.  Without it a
# merge commit is compared against its first parent, which for a PR merge is
# the PR branch tip, so the merge looks like it changed every path main gained
# since the branch point and a docs-only PR is classified as image-affecting.
# On the first-parent chain each commit is a state of main and its own diff is
# what landed on main, which is exactly what decides whether Coolify owes a
# build.

# Single-shot reuse of the existing gate. Capture both streams; the gate logs to stderr.
set +e
VERIFY_OUT="$(
  DEPLOY_VERIFY_HOST="$HOST" \
  DEPLOY_VERIFY_TIMEOUT_SECONDS=0 \
  DEPLOY_VERIFY_NO_FETCH=1 \
  DEPLOY_VERIFY_CURL_TIMEOUT_SECONDS="$CURL_TIMEOUT_SECONDS" \
  bash "$VERIFY" "$EXPECTED_SHA" 2>&1
)"
VERIFY_CODE=$?
set -e

log "verify-deploy-sha exit ${VERIFY_CODE}"
printf '%s\n' "$VERIFY_OUT" | sed 's/^/[verify-deploy-sha] /' >&2

LIVE_SHA=""
LIVE_FULL=""
OLDEST_UNDEPLOYED=""
OLDEST_AGE=""
VERDICT="ok"
NOTIFY_REASON=""

extract_live_sha() {
  # Prefer a live probe so we do not depend on log-line wording.
  local body
  body="$(curl -sS --max-time "$CURL_TIMEOUT_SECONDS" "${HOST%/}/api/health" 2>/dev/null || true)"
  printf '%s' "$body" | jq -r '.checks.release.sha // empty' 2>/dev/null || true
}

maybe_notify() {
  # $1 reason tag, $2 message
  if [ "$NOTIFY" != "1" ]; then
    log "notify skipped (DEPLOY_FRESHNESS_NOTIFY=${NOTIFY})."
    return 0
  fi
  case "$PREVIOUS" in
    failure)
      if [ "$1" != "recovered" ]; then
        log "notify skipped (same incident as previous failure; de-dupe)."
        return 0
      fi
      ;;
    success|none)
      if [ "$1" = "recovered" ]; then
        log "notify skipped (no prior failure to recover from)."
        return 0
      fi
      ;;
    *)
      log "warn: unknown PREVIOUS_CONCLUSION '${PREVIOUS}' - treating as none."
      if [ "$1" = "recovered" ]; then
        return 0
      fi
      ;;
  esac
  if [ ! -f "$FLEET_POST" ]; then
    log "notify skipped (agent-sync-fleet-post.sh not present)."
    return 0
  fi
  AGENT_SYNC_SEAT="${AGENT_SYNC_SEAT:-ST}" \
  AGENT_SYNC_REPO="${AGENT_SYNC_REPO:-Socratic-Trade}" \
  AGENT_SYNC_TOPIC="${AGENT_SYNC_TOPIC:-fleet}" \
    bash "$FLEET_POST" "$2" || log "warn: agent-sync fleet post failed (no Zulip creds?)."
}

case "$VERIFY_CODE" in
  0)
    VERDICT="fresh"
    log "PASS: live contains ${EXPECTED_SHA}."
    maybe_notify recovered "deploy freshness recovered: prod contains ${EXPECTED_SHA:0:12}.  Silent-freeze watch is clear.  #2545"
    exit 0
    ;;
  1)
    if [ "$TREAT_UNREACHABLE_OK" = "1" ]; then
      log "health unreachable or unparseable - not the silent-freeze class (UptimeRobot pages site-down). Treating as OK."
      exit 0
    fi
    log "FAIL: operational/reachability error from verify-deploy-sha."
    exit 1
    ;;
  2)
    VERDICT="no-sha"
    log "FAIL: production publishes no release sha."
    maybe_notify no-sha "deploy freshness: prod /api/health has no .checks.release.sha so drift cannot be verified.  Check Coolify SOURCE_COMMIT injection.  #2545"
    exit 2
    ;;
  4)
    VERDICT="divergent"
    LIVE_SHA="$(extract_live_sha)"
    log "FAIL: production is on a divergent commit (live ${LIVE_SHA:-unknown}, expected ${EXPECTED_SHA})."
    maybe_notify divergent "deploy freshness DIVERGENT: prod ${LIVE_SHA:-unknown} neither contains nor is contained by origin/main ${EXPECTED_SHA:0:12}.  Escalate before anything touches production.  #2545"
    exit 4
    ;;
  5)
    VERDICT="unknown-live"
    LIVE_SHA="$(extract_live_sha)"
    log "FAIL: live ${LIVE_SHA:-unknown} is not a commit in this repo."
    maybe_notify unknown "deploy freshness: prod is running ${LIVE_SHA:-unknown}, which is not in this repo.  Fetch and re-check; if it persists, escalate.  #2545"
    exit 5
    ;;
  3)
    ;;
  *)
    log "FAIL: unexpected verify-deploy-sha exit ${VERIFY_CODE}."
    exit 1
    ;;
esac

# Exit 3 from the gate: live is a strict ancestor of expected. Age the oldest gap.
LIVE_SHA="$(extract_live_sha)"
[ -n "$LIVE_SHA" ] || fail_usage "verify-deploy-sha reported behind but /api/health has no release sha."
LIVE_FULL="$(resolve_commit "$LIVE_SHA")"
[ -n "$LIVE_FULL" ] || fail_usage "cannot resolve live sha '${LIVE_SHA}' after a behind verdict."

# NOT `git log ... | head -n 1`: under `set -euo pipefail` head closes the pipe as
# soon as it has its line, git takes SIGPIPE, the pipeline reports 141, and the
# script dies with 141 instead of its real verdict. That is a race on how much git
# has written when head exits, so it fired intermittently in CI and took the whole
# `verify-hosted` lane -- and therefore the required `verify` gate -- down with it
# (FLEET-INFRA-BH). Take the first line with parameter expansion; no pipe, no race.
#
# The pathspec is the point: only a commit that changed a watched path is owed
# a deployment, so only such a commit may age the verdict.  An old CI-only
# commit earlier in the gap must not make a fresh runtime commit look stale.
#
# A git failure here is NOT an empty list.  Git exits 0 with empty output for a
# pathspec that matches nothing, which is the image-noop verdict, and it exits
# non-zero when it cannot do the job at all:  a missing object, a corrupt repo,
# a killed git.  Swallowing that exit status would turn an operational failure
# into a green image-noop pass, so the status is captured and the error is
# raised.  "git errored" has to stay distinct from "no watched commit".
set +e
UNDEPLOYED_LIST="$(git rev-list --first-parent --reverse "${LIVE_FULL}..${EXPECTED_SHA}" -- $WATCH_PATHS 2>&1)"
REV_RC=$?
set -e
[ "$REV_RC" -eq 0 ] || fail_usage "git rev-list failed (exit ${REV_RC}): ${UNDEPLOYED_LIST}"

OLDEST_UNDEPLOYED="${UNDEPLOYED_LIST%%$'\n'*}"
if [ -z "$OLDEST_UNDEPLOYED" ]; then
  # Live is behind, but nothing in the gap can change the image, so Coolify
  # never owed a deployment for it.  Not the silent-freeze class, and this is
  # the case ST-4575 was about: a CI-only commit must never age the verdict.
  #
  # The recovery notification belongs here as well as in the fresh branch.  The
  # premise of this fix is that the gaps that paged before were CI-only gaps
  # that now resolve to image-noop, so without this the four outstanding stale
  # pages would never be closed and any later stale -> image-noop transition
  # would leave the incident open forever.
  VERDICT="image-noop"
  log "PASS: live is behind ${EXPECTED_SHA}, but no commit in the gap touches a watched path."
  log "  no deployment was owed for this gap, so there is nothing to wait for."
  maybe_notify recovered "deploy freshness recovered: prod ${LIVE_FULL:0:12} is behind ${EXPECTED_SHA:0:12}, but no commit in the gap touches a watched path, so no deployment was owed.  Silent-freeze watch is clear.  #2545"
  exit 0
fi

OLDEST_CT="$(git log -1 --format=%ct "$OLDEST_UNDEPLOYED")"
NOW_EPOCH="$(date +%s)"
OLDEST_AGE=$((NOW_EPOCH - OLDEST_CT))
if [ "$OLDEST_AGE" -lt 0 ]; then
  OLDEST_AGE=0
fi

OLDEST_ISO="$(git log -1 --format=%cI "$OLDEST_UNDEPLOYED")"
log "oldest image-affecting undeployed ${OLDEST_UNDEPLOYED} (${OLDEST_ISO}) age ${OLDEST_AGE}s (threshold ${STALE_SECONDS}s)"
log "  live ${LIVE_FULL}  expected ${EXPECTED_SHA}"

if [ "$OLDEST_AGE" -lt "$STALE_SECONDS" ]; then
  VERDICT="in-flight"
  log "PASS: main is ahead but the oldest image-affecting undeployed commit is still inside the ${STALE_SECONDS}s deploy window."
  exit 0
fi

VERDICT="stale"
HOURS=$((OLDEST_AGE / 3600))
MINS=$(((OLDEST_AGE % 3600) / 60))
log "FAIL: production is STALE - oldest image-affecting undeployed commit is ${HOURS}h${MINS}m old."
log "  this is the silent-freeze class (webhook 200s, health green on an old sha)."
log "  do NOT hand-trigger a deploy - investigate the webhook and Coolify build queue."

maybe_notify stale "deploy freshness STALE: prod ${LIVE_FULL:0:12} is behind origin/main ${EXPECTED_SHA:0:12}.  Oldest image-affecting undeployed ${OLDEST_UNDEPLOYED:0:12} (${OLDEST_ISO}) is ${HOURS}h${MINS}m old.  Silent freeze class - webhook 200s, health green on the old sha.  Do not hand-trigger.  Investigate Coolify queue / SSH exec stream.  #2545"

exit 3

#!/usr/bin/env bash
# verify-branch-protection.sh - assert that `main` still carries the branch protection this repo
# depends on, and that the required contexts are ones CI actually produces.
#
# WHY THIS EXISTS. `main` was UNPROTECTED until 2026-09-27. The practical consequence was not
# theoretical: a merge driver reading the PR-level `statusCheckRollup` saw "no pending checks, no
# failed checks" on a head whose CI had not been dispatched yet, and would have merged a PR whose
# full test suite never executed. Protection was added the same day. But protection is a REMOTE
# SETTING -- it is invisible in the diff, so a well-meaning cleanup, a `gh api -X DELETE
# .../protection` from a debugging session, or a repo settings reset silently removes it, and the
# only symptom is the failure mode above coming back.
#
# So this is the counterpart to test/branch-protection-gate.test.ts, which is a STATIC guard: it
# proves the workflows keep producing a `verify` gate that cannot fail open. It cannot see the
# protection itself. This script sees the protection but not the workflows, and it checks the two
# agree -- specifically that every required context is a job that CI actually defines, which is the
# pairing that turns "required" from a fleet-wide wedge into a real gate.
#
# IT VERIFIES ONLY. It never writes protection, never merges, never force-pushes. If it fails, the
# fix is to re-apply the protection deliberately (see the RE-APPLY block at the bottom), not to
# work around it by loosening the required contexts.
#
# USAGE
#   bash scripts/verify-branch-protection.sh                 # verify only
#   REPO=owner/name bash scripts/verify-branch-protection.sh
#
# EXIT CODES
#   0  protection present and consistent with the workflows
#   1  protection missing, or a required context CI does not produce  (FAIL)
#   2  could not determine  (no gh auth, network, unexpected shape)  (UNKNOWN - never a silent pass)
set -uo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)}"
BRANCH="${BRANCH:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

# Contexts protection is EXPECTED to require. Kept in sync with
# test/branch-protection-gate.test.ts, which pins the workflow side of the same pairing.
EXPECTED_CONTEXTS=("verify" "gitleaks")

die_unknown() { echo "[verify-branch-protection] UNKNOWN: $*" >&2; exit 2; }
die_fail()    { echo "[verify-branch-protection] FAIL: $*" >&2; exit 1; }

[ -n "$REPO" ] || die_unknown "could not resolve a repository (is gh authenticated?)."

# ── 1. Does the protection exist at all? ────────────────────────────────────────────────────────
# A 404 here is the real finding: the guard is simply gone. Distinguish it from any other error so
# a network blip is never reported as "protection removed".
raw=$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>&1)
status=$?
if [ $status -ne 0 ]; then
  if printf '%s' "$raw" | grep -q "Branch not protected"; then
    die_fail "$BRANCH has NO branch protection. See the RE-APPLY block at the bottom of this script."
  fi
  die_unknown "protection lookup failed: $(printf '%s' "$raw" | head -c 300)"
fi

actual_contexts=$(printf '%s' "$raw" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception as e:
    print("__PARSE_ERROR__"); raise SystemExit
print("|".join(d.get("required_status_checks",{}).get("contexts",[])))
' )
case "$actual_contexts" in
  __PARSE_ERROR__) die_unknown "could not parse the protection payload as JSON" ;;
esac
[ -n "$actual_contexts" ] || die_fail "$BRANCH requires no status checks at all."

echo "[verify-branch-protection] required contexts: $actual_contexts"
echo "[verify-branch-protection] strict (must be up to date with $BRANCH before merge): \
$(printf '%s' "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("required_status_checks",{}).get("strict"))' 2>/dev/null || echo unknown)"

# ── 2. Does every required context correspond to a job CI actually defines? ───────────────────
# A required context that no workflow can ever report is worse than no protection: every PR sits
# BLOCKED forever with a check name that appears nowhere in the logs. This is the failure mode that
# makes a context rename a fleet-wide outage.
# Split on the PIPE explicitly. `for ctx in $actual_contexts` word-splits on IFS (space/tab/newline),
# NOT on `|`, so the loop body ran exactly once with ctx="verify|gitleaks" - and because `|` is
# alternation in an ERE, `grep -E "^  verify|gitleaks:$"` matches almost anything. The guard then
# passed for the wrong reason and would have approved a protection naming a context no workflow
# produces, which is precisely the failure it exists to catch. (Found by Seer, HIGH, 2026-09-27.)
IFS='|' read -r -a required_contexts <<< "$actual_contexts"
[ "${#required_contexts[@]}" -gt 0 ] || die_fail "could not parse required contexts from: $actual_contexts"
for ctx in "${required_contexts[@]}"; do
  [ -n "$ctx" ] || continue
  found=0
  for wf in "$REPO_ROOT"/.github/workflows/*.yml "$REPO_ROOT"/.github/workflows/*.yaml; do
    [ -f "$wf" ] || continue
    # A job definition, not a reference to the context somewhere in a run block. The name is
    # interpolated into an ERE, so escape it: a context containing regex metacharacters would
    # otherwise match something other than itself.
    if grep -Eq "^  $(printf '%s' "$ctx" | sed 's/[][\.^$*+?(){}|\\]/\\&/g'):[[:space:]]*$" "$wf"; then found=1; break; fi
  done
  [ "$found" -eq 1 ] || die_fail "required context \"$ctx\" is not defined as a job in any workflow under .github/workflows/ -- every PR would hang at BLOCKED."
done

# ── 3. Report the rest of the posture, without gating on it ───────────────────────────────────
printf '%s' "$raw" | python3 -c '
import json,sys
d=json.load(sys.stdin)
def flag(x, default="unknown"):
    if x is None: return default
    if isinstance(x, dict): return str(x.get("enabled", default)).lower()
    return str(x).lower()
print("[verify-branch-protection] enforce_admins:            " + flag(d.get("enforce_admins")))
print("[verify-branch-protection] required approvals:       " + str((d.get("required_pull_request_reviews") or {}).get("required_approving_review_count", 0)))
print("[verify-branch-protection] conversation resolution:   " + flag(d.get("required_conversation_resolution")))
print("[verify-branch-protection] allow force pushes:        " + flag(d.get("allow_force_pushes")))
print("[verify-branch-protection] allow deletions:           " + flag(d.get("allow_deletions")))
' 2>/dev/null || true

echo "[verify-branch-protection] PASS: $BRANCH protection present, and every required context is a job CI defines."
echo "[verify-branch-protection] reminder: the WORKFLOW side of this pairing is pinned by"
echo "[verify-branch-protection]          test/branch-protection-gate.test.ts (no network). Run both."

# ── RE-APPLY (only if this script FAILED) ──────────────────────────────────────────────────────
# Deliberately left as a comment rather than a flag: re-applying protection is a fleet-wide change
# that should be a considered act, not something a script does behind a flag nobody reads.
#
#   gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
#   {
#     "required_status_checks": { "strict": true, "contexts": ["verify", "gitleaks"] },
#     "enforce_admins": false,
#     "required_pull_request_reviews": {
#       "dismiss_stale_reviews": false, "require_code_owner_reviews": false,
#       "required_approving_review_count": 0, "require_last_push_approval": false
#     },
#     "restrictions": null,
#     "required_linear_history": false,
#     "allow_force_pushes": false,
#     "allow_deletions": false,
#     "required_conversation_resolution": true,
#     "lock_branch": false,
#     "allow_fork_syncing": false
#   }
#   JSON
#
# Why each field, since a blind paste is how a fleet wedges itself:
#   contexts verify,gitleaks  - the purpose-built aggregate gate + the credential guard. Neither has
#                               a path filter, so both report on every PR (asserted by the test).
#   strict: true              - the branch must be current with main, closing the stale-UI/text land
#                               that AGENTS.md warns about and scripts/land.sh already re-syncs for.
#   approvals: 0              - a personal repo has no second approver. A non-zero count would block
#                               EVERY agent merge fleet-wide, which is a wedge, not a gate.
#   enforce_admins: false     - keeps a documented owner escape hatch for an incident hotfix. The
#                               threat protection addresses is an ACCIDENTAL ungated merge, and
#                               agents are not admins, so the guard still holds where it matters.
#   conversation resolution   - unresolved bot review threads become a hard block instead of a
#                               confusing BLOCKED state (this is what Seer's two findings did).
#   force pushes / deletions  - off, so main cannot be rewritten out from under CI.
exit 0

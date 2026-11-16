# 2026-07-09 — Merge shepherd: auto-land completed background PRs

## Summary

Adds automation so completed background work stops silently rotting as stale open PRs:

1. **`.gitattributes`** — add `docs/EFFORT-LOG.md merge=union` (STATUS.md/PLAN.md already had it).
2. **`scripts/merge-shepherd.sh`** — drives auto-merge-armed PRs home + reports every open PR.
3. **`.github/workflows/merge-shepherd.yml`** — manual-dispatch trigger for the shepherd.
4. **launchd job** (`com.jay.merge-shepherd`, Mac fleet host, not in-repo) — the scheduled driver,
   every 30 min, using the host's `gh auth token` PAT.

## Why

Diagnosed root cause: the merge gate is lenient (ruleset requires only the `verify` check — no
approvals, not strict, no thread-resolution), yet green auto-merge-armed PRs sit for hours/days.
Cause: the handoff protocol makes **every** PR edit `docs/EFFORT-LOG.md` + `STATUS.md`, so each
merge turns every other open PR CONFLICTING. GitHub's native auto-merge can't self-heal a conflict,
and `land.sh` arms auto-merge once and never returns — so a PR that later conflicts (or whose `verify`
never dispatched) is stranded and forgotten. That is exactly the owner's report: "I think it was made,
but it went idle and forgotten."

Fix = remove the dominant conflict source (union-merge on the board file) + a shepherd that "comes
back": re-syncs stuck PRs (union-merge auto-resolves board conflicts on `update-branch`), re-runs
flaky `verify` once, merges the green ones, and publishes a digest.

## Behaviour / safety

- **Acts only on PRs the author already ARMED** auto-merge (i.e. went through `land.sh`). Everything
  else is reported, never force-merged.
- Green signal = the required `verify` check is SUCCESS. Uses attempt-and-react (the merge attempt
  itself resolves GitHub's lazy mergeability) rather than trusting the often-`UNKNOWN` mergeable flag.
- Merge-to-`main` is NOT deploy-to-prod (auto-deploy is OFF; prod is a separate ANNOUNCE-THEN-DEPLOY
  step) — so auto-landing to `main` keeps the human checkpoint at release time.
- Publishes an owner-facing digest to a single tracking issue ("Merge shepherd status") every run:
  merged / un-stuck / re-ran / real-conflict / verify-failing / not-armed / draft.
- Reversible: `launchctl bootout gui/$(id -u)/com.jay.merge-shepherd`.

## Files

- `.gitattributes`, `scripts/merge-shepherd.sh`, `.github/workflows/merge-shepherd.yml`
- launchd plist `~/Library/LaunchAgents/com.jay.merge-shepherd.plist` + script copy at
  `~/.claude-merge-shepherd/merge-shepherd.sh` (host-local, not in-repo — mirrors the disk janitor).

## Verification

- `bash -n scripts/merge-shepherd.sh` clean; `SHEPHERD_DRY_RUN=1` dry-run correctly classified the live
  backlog (3 would-merge green, 3 would-re-sync verify=NONE, 3 not-armed/parked, 1 draft).
- First supervised live run + launchd install recorded below / in STATUS.

## 2026-07-09 update — PR #1215 review-round robustness fixes

Batch fix for 8 confirmed-real code-review findings on `scripts/merge-shepherd.sh` and
`.github/workflows/merge-shepherd.yml` (a 9th, `.gitattributes` transitional gap, is
documented above under Follow-ups; no code change needed for it):

- **Workflow-dispatch privilege pin**: `merge-shepherd.yml`'s checkout now pins
  `ref: main`, so a `workflow_dispatch` run against any other branch still executes
  `main`'s copy of `scripts/merge-shepherd.sh`, not a branch-modified one, with the
  job's write-scoped token.
- **Stranded-PR classification**: introduced a `running` check count (in-flight
  IN_PROGRESS/QUEUED/PENDING/EXPECTED checks) distinct from `nchecks` (any check ever
  posted, running or not). The WAITING-vs-resync decision now keys on `running`, so a
  PR whose `verify` never dispatched but where some other check (gitleaks, e2e) already
  finished gets re-synced instead of parked in WAITING forever.
- **Fail-closed PR scan**: `gh pr list` failures now abort the run (non-zero exit,
  visible stderr) instead of silently producing a zero-count "all clear" digest.
- **MERGE-RETRY surfaced**: added to both the digest count table and the detail-list loop
  (previously written to the raw table but never displayed).
- **Terminal check conclusions**: `is_failure_conclusion()` now treats
  CANCELLED/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE/STALE the same as FAILURE
  (rerun-once, then escalate) instead of parking them in WAITING forever.
- **Head-sha-scoped rerun marker**: the "already reran once" marker moved from a
  PR-wide `shepherd-reran` label to a PR comment containing the head sha
  (`<!-- shepherd-reran:<sha> -->`), so a flaky failure on a later head after a prior
  rerun still gets its own rerun instead of being mis-escalated as persistent.
- **PAT-gated re-syncs from Actions**: workflow now exports `SHEPHERD_HAS_PAT` (1 only
  when `SHEPHERD_TOKEN` is set); the script skips `update-branch` and reports
  "re-sync skipped -- no PAT" when it's 0, instead of running update-branch with
  `GITHUB_TOKEN` (which can't re-trigger `verify`) and then falsely reporting
  "verify re-running".
- **ASCII-only**: converted all em dashes/arrows/emoji in `scripts/merge-shepherd.sh`
  to plain ASCII (`--`, `->`, `[bucket]` tags) per the AGENTS.md pure-ASCII rule for
  `scripts/*.sh` — the scheduled driver runs under the Mac's Bash 3.2.57.

### Verification

- `grep -nP '[^\x00-\x7F]' scripts/merge-shepherd.sh` — clean (no matches).
- `bash -n scripts/merge-shepherd.sh` — clean.
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/merge-shepherd.yml'))"` — clean.

## Follow-ups

- Optional: add a `SHEPHERD_TOKEN` PAT repo secret so the GitHub-Actions dispatch path can also
  re-trigger `verify` on re-synced PRs (the launchd driver already does, via the host PAT). Until
  that secret exists, the Actions dispatch path reports "re-sync skipped -- no PAT" instead of
  attempting an update-branch that couldn't re-trigger CI anyway (see `SHEPHERD_HAS_PAT` in
  `scripts/merge-shepherd.sh`).
- The shepherd is per-repo; replicate the launchd job for Congress.Trade etc. if wanted.
- One-time transitional gap: git resolves `merge=union` attributes from the checked-out (PR head)
  tree, not the base, so a PR whose head predates this `.gitattributes` entry still gets a real
  conflict on `docs/EFFORT-LOG.md` on its *first* `update-branch` sync. The shepherd already
  degrades safely there -- that failure lands in the CONFLICT bucket + `needs-human-merge` label,
  not silent rot -- and any branch that syncs once, or forks after this landed, carries the
  attribute thereafter. No code change needed; if the existing backlog needs to clear faster than
  one-conflict-at-a-time, do a manual one-time backfill (check out each stale head, copy the new
  `.gitattributes` into the working tree uncommitted, `git merge origin/main`, push).

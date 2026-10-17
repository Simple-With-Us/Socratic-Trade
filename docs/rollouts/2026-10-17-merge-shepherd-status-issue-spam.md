# 2026-10-17 — Merge shepherd stops opening duplicate status issues (ST-4553)

## Context & Objective

The repo had 866 open "Merge shepherd status" issues on 2026-10-17, one more every 30 minutes (newest #4848).  The 2026-10-05 slug fix (`docs/rollouts/2026-10-05-merge-shepherd-repo-slug.md`) never reached the Mac:  LaunchAgent `com.jay.merge-shepherd` runs the host-local copy `~/.claude-merge-shepherd/merge-shepherd.sh`, which is refreshed from `main` by hand.  That copy still searched the legacy slug, the search answered empty, and every empty answer created another issue.  The lookup also discarded `gh` errors, so any search failure did the same.

The owner wants every GitHub issue paired one to one with a Linear issue (AFC-336), so a stream of status issues would also flood Linear once GitHub issue sync is on.

## Changes Made

- The tracking issue is opt-in:  `SHEPHERD_STATUS_ISSUE=1`.  By default the digest goes only to stdout (the launchd log) and the Actions step summary.
- `find_status_issue` lists open issues over REST (`repos/<repo>/issues`) instead of the search API, and returns the oldest match when duplicates exist.
- `publish_status_issue` fails closed:  a failed lookup logs and creates nothing.
- `scripts/merge-shepherd-status-issue.selftest.sh` covers all three with a stub `gh`, and CI now runs both shepherd selftests.

**Files:** `scripts/merge-shepherd.sh`, `scripts/merge-shepherd-status-issue.selftest.sh`, `.github/workflows/ci.yml`, this note.

## Decisions & Trade-offs

- Off by default rather than fixed in place:  nobody noticed 866 duplicates in 12 days, so the issue is not being read, and a permanently open status issue would become a permanent Linear issue under sync.
- The script does not close duplicates itself:  closing 866 issues in one run would hit GitHub's content-creation limits.  They are closed separately, throttled.

## Verification State

```bash
bash -n scripts/merge-shepherd.sh
bash scripts/merge-shepherd-status-issue.selftest.sh
bash scripts/merge-shepherd-ci-inflight.selftest.sh
```

A mutant that restores the old fail-open lookup fails the new selftest.

## Next Steps & Blockers

- **Owner, on the Mac, after merge:**  refresh the host copy, or the spam continues:  `cd ~/Code/Socratic-Trade && git fetch -q origin && git show origin/main:scripts/merge-shepherd.sh > ~/.claude-merge-shepherd/merge-shepherd.sh`.
- Then close the duplicate issues (throttled, AFC-336).

## Zero-Code Findings

- The host-copy model is the root cause of both this and the 2026-10-05 incident:  fixes merged to `main` do not run on the Mac until someone copies them.

# 2026-09-08 - ci-deploy-freshness-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-C1** / PagerDuty **#87** flagged the
`ci-deploy-freshness` Crons monitor as regressed (active incident since
2026-09-08T18:13Z).  Investigation (`GET
/organizations/jays-services/monitors/ci-deploy-freshness/`, `gh run list
--workflow deploy-freshness.yml`) found the workflow itself healthy and the
monitor's 15-minute `checkin_margin` structurally mismatched to GitHub's
best-effort schedule delivery.  Goal:  stop false pages on a job that has never
failed, without weakening the watchdog's ability to catch a real silent-deploy
freeze.

## Changes Made

Widened the Sentry Crons `checkin_margin` used for the `ci-deploy-freshness`
monitor (workflow `Deploy freshness`, `.github/workflows/deploy-freshness.yml`)
from 15 minutes to 600 minutes (10h), via a new per-workflow
`CRON_CHECKIN_MARGIN_MINUTES` override in `scripts/sentry-ci-report.py`.  No
other monitor's margin changed (default stays 15 min).  The workflow's own
declared cadence (`schedule: cron: "13,33,53 * * * *"`, i.e. every 20 minutes)
is unchanged.

Evidence that drove the change:

- The workflow itself is healthy:  every run since it was created
  (2026-08-20) concluded `success`.  It has never failed.
- GitHub's `schedule` trigger for this workflow is delivered on a
  best-effort basis and, empirically, delivers far less often than declared.
  Over the 211 hours before this fix (2026-08-30T22:43Z .. 2026-09-08T18:03Z),
  only 60 of the ~634 scheduled fires GitHub should have created for a
  20-minute cron actually ran (~9.5% delivery).  Every gap between consecutive
  runs exceeded 60 minutes; median gap 210.5 min; p99/max 483.6 min
  (~8h03m).  (`gh run list --workflow deploy-freshness.yml --limit 60 --json
  databaseId,event,status,conclusion,createdAt`, filtered to `event ==
  "schedule"`.)
- The Sentry monitor's `checkin_margin` was hardcoded to 15 minutes for
  every schedule-triggered workflow in this script, so it was structurally
  guaranteed to open a "missed check-in" incident every few hours against a
  job that was never actually broken — a false page, not a real regression.
  Each successful check-in re-upserts `monitor_config` from this script
  (`isUpserting: true` on the live monitor), so the false-page cycle would
  repeat indefinitely without a code change here.

This is category (b) from the remediation runbook:  the workflow runs fine,
but the monitor's margin didn't match GitHub's real scheduling delivery.

Files touched:

- `scripts/sentry-ci-report.py` — added `CRON_CHECKIN_MARGIN_MINUTES` dict
  (default 15 min, override 600 min for `"Deploy freshness"`); checkin
  payload now reads the margin from `CRON_CHECKIN_MARGIN_MINUTES.get(workflow_name,
  15)` instead of a bare `15`.
- `docs/EFFORT-LOG.md` — mirror row for this effort.
- `STATUS.md` / `PLAN.md` — handoff + monitoring-approach entries (Codex P1 tip-fix).
- `docs/rollouts/2026-09-08-ci-deploy-freshness-monitor-margin.md` — this note
  (restructured to mandated sections).

## Decisions & Trade-offs

600 minutes (10h) sits with headroom above the worst gap measured so far
(~8h03m) while still alerting well inside the 14-hour silent-deploy-freeze
(2026-08-06) that this watchdog exists to catch — the workflow compares
`origin/main` against the live `/api/health` release SHA and independently
fails/pages Slack on genuine staleness (`DEPLOY_FRESHNESS_STALE_SECONDS=3600`)
every time it *does* run, regardless of this Sentry margin.  The Sentry Crons
monitor here answers a narrower question — "is the watchdog itself still
alive" — and needed calibrating to what GitHub can actually deliver, not to
the aspirational cron string.

The crontab schedule itself was left untouched:  it documents the intended
cadence and is what a healthy GitHub scheduler would honor; only the
tolerance for GitHub's own delivery jitter changed.

Deliberately NOT `"Fixes FLEET-INFRA-C1"`:  the currently-open Sentry Crons
incident should only be marked resolved once a real check-in lands OK under
the new margin, not merely because this PR merged.

Out of scope:  fleet-wide `checkin_margin` vs observed GitHub delivery for
other short-interval scheduled workflows (`usage-monitor-scheduler`, CT
`watcher-cron` / `agreement-autopublish-cron`).

## Verification State

This change is Python-only (`scripts/sentry-ci-report.py`) plus docs/handoff
prose.  Feasible local gate on the tip-fix worktree (2026-09-09 Fixer/Grok):

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
```

Honest N/A for the full AGENTS.md JS gate on this tip:

- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` — **not
  run** here; the tip touches no TypeScript/JS product code, and inventing
  full-suite green results would be false.  Hosted `verify-hosted` remains
  the gate of record for any JS on this PR.
- Manually confirmed the prior CRON_SCHEDULES block is unchanged (the
  `test/sentry-ci-report-workflows.test.ts` cron-mapping regex still extracts
  the same object); coverage regex never reads `CRON_CHECKIN_MARGIN_MINUTES`.
- Did **not** manually PUT the Sentry monitor config directly — the next
  successful check-in from this workflow will upsert it with the new margin
  automatically (`isUpserting: true`).  See the parent remediation report for
  any interim direct PUT applied to stop paging while this PR lands.

## Next Steps & Blockers

- Resolve Codex P1 review threads on PR #3194 after this tip lands (identity,
  STATUS/PLAN/rollout/verification/two-space).
- Mark FLEET-INFRA-C1 resolved once a check-in with the new `monitor_config`
  lands `ok` (or immediately if an interim direct PUT already applied) — not
  purely on this PR merging, since GitHub may not fire the workflow again for
  hours.
- Optional follow-up (out of scope here):  fleet-wide pass on `checkin_margin`
  vs observed GitHub Actions delivery cadence for other short-interval
  scheduled workflows.
- Blockers:  none.  Pure config/tolerance + docs; no behavior of the
  `Deploy freshness` job itself changed.  This lane does not merge.

# 2026-10-05 — Effort-issues sync retries an idempotent HTTP 500

## Summary

`Effort Issues Sync` run `37388978298` (push of `a7086c779`, 2026-10-05 6:31pm) updated dozens of issues and then died:

```
RuntimeError: update issue #3797 failed: 500 {}
```

A GitHub 500 with an empty body is an edge fault.  The reconcile is a few hundred serial PATCHes, so one unretriable 500 left the Issues mirror only partly updated.  `docs/EFFORT-LOG.md` was not touched by the failure.

## What changed

`scripts/sync-effort-issues.py`

- `GitHubClient._request` now retries an idempotent 5xx, and a bare 429, on the existing rate-limit budget.  That covers PATCH 500, which `_rate_limited` did not.
- 502/503/504 stay on that budget for every method.  That older gateway path is unchanged.
- POST 500 is not replayed.  A create can land and still return `{}`.
- A 4xx other than a rate-limit 403/429 is still final.
- If the budget runs out, the run is still the existing partial sync (exit 0).  The next push of the board, or the daily cron, resumes.  The script does not skip the failed issue and keep PATCH-ing through an outage.

`scripts/sync_effort_issues_retry_test.py` locks those decisions.

## Why not keep going after one failed issue

A 500 `{}` is an edge fault.  The next PATCH is likely to get the same answer.  Continuing the rest of a 200-issue run would hammer a sick API.  Stopping as a partial sync is the path 504 already uses, and the sync is idempotent.

## Verification

```
python3 -m py_compile scripts/sync-effort-issues.py
python3 -m unittest scripts/sync_effort_issues_retry_test.py
```

`npm test` is unchanged by this Python file.  `scripts/land.sh` still runs it before the PR.

## Follow-ups

None.  The daily cron remains the drift catch if this run ends partial.  Do not dispatch the workflow by hand.

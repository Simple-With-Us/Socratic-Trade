# 2026-10-10 - Effort-issues sync retries an idempotent HTTP 500

## 1. Context & Objective

`Effort Issues Sync` run `37388978298` (push of `a7086c779`, 2026-10-05 6:31pm) updated dozens of issues and then died:

```
RuntimeError: update issue #3797 failed: 500 {}
```

A GitHub 500 with an empty body is an edge fault, not a validation error.  The reconcile is a few hundred serial PATCHes, so one unretriable 500 left the Issues mirror only partly updated.  The workflow failed 2 of its last 30 runs on 2026-10-05.  `docs/EFFORT-LOG.md` itself was not touched by the failure.

The fix was written by BF-FIXER on 2026-10-05 (commit `e289548e6`, lane `~/apps/socratic-trade-bf-fixer-effort-sync`, branch `bf-fixer/effort-sync-http-500-retry`) and never pushed.  A 2026-10-10 review of the kept lanes found it worth landing, cherry-picked it onto `main` in scratch (clean apply, 10 of 10 tests), and this change lands it.  The code and tests are BF-FIXER's.  The log rows and this note were regenerated for 2026-10-10.

Board `7989bcda8b29412ab9e26a93c7825a0d`.

## 2. Changes Made

`scripts/sync-effort-issues.py`

- `GitHubClient._request` now asks `_should_retry_response` instead of `_rate_limited`.  An idempotent 5xx (GET/HEAD/PUT/PATCH/DELETE), including a bare 500 with an empty body, and a bare 429 now spend the existing rate-limit retry budget.  That covers PATCH 500, which `_rate_limited` did not.
- 502/503/504 stay on that budget for every method.  That older gateway path is unchanged.
- A POST 500 is not replayed.  A create can land and still return `{}`, and a replay would duplicate the issue.
- A 4xx other than a rate-limit 403/429 is still final.
- If the budget runs out, the run is still the existing partial sync (exit 0).  The next push of the board, or the daily cron, resumes.

`scripts/sync_effort_issues_retry_test.py` (new) locks those decisions in ten stdlib `unittest` cases.

Files touched:

- `scripts/sync-effort-issues.py`
- `scripts/sync_effort_issues_retry_test.py`
- `docs/rollouts/2026-10-10-effort-sync-http-500-retry.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## 3. Decisions & Trade-offs

- **Stop after the budget, do not skip the failed issue.**  A 500 `{}` is an edge fault.  The next PATCH is likely to get the same answer, so carrying on through a 200-issue run would hammer a sick API.  Stopping as a partial sync is the path 504 already uses, and the sync is idempotent.
- **Reuse the existing budget and backoff.**  No new knob.  A 500 has no `Retry-After`, so the existing capped exponential guess applies.
- **POST stays unreplayed on 500 and on a bare 429.**  Only a 429 whose body carries a rate-limit message retries a POST, as before.
- **The test file is not wired into CI.**  The repo has no other Python tests and neither `ci.yml` nor `effort-issues-sync.yml` runs `unittest`.  Adding a step to the required `verify` gate, or to the sync workflow, was out of scope for a salvage.  Run it by hand (below).

## 4. Verification State

```
python3 -m py_compile scripts/sync-effort-issues.py
python3 -m unittest scripts/sync_effort_issues_retry_test.py
```

Both pass on a fresh worktree off `origin/main` (10 tests).  The `tsc` / `npm test` / `npm run build` trio is not affected by a Python-only change and runs in the required `verify` CI check on the PR.  Do not dispatch the sync workflow by hand.

## 5. Next Steps & Blockers

- Other registered repos carry their own copies of `scripts/sync-effort-issues.py`, and their sha1s already differ from this one (Autorotate, DealDex, Personal-Site and Usage-Monitor share one copy;  Congress.Trade and congress-trading-shared each differ).  They keep the 502/503/504-only budget.  Propagate through normal owned PRs per `EFFORT-LOG-PROTOCOL.md` if the same 500 shows up there.
- Optionally wire the retry test into CI (owner or reviewer call).

## 6. Zero-Code Findings

None.  This is a code change.

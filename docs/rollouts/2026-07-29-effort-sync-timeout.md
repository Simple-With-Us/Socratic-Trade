# 2026-07-29 - Effort Issues Sync hang fix [KIMI]

## Context & Objective
`Effort Issues Sync` hung twice on 2026-07-29 (runs 30471155663, 30487021535),
each time stuck 10+ min in the sync step on the single `socratic-ci` runner,
starving the PR verify queue during an owner-directed merge drain. Both runs
were manually cancelled to unblock CI.

## Changes Made
- `scripts/sync-effort-issues.py`: `urllib.request.urlopen(req)` ->
  `urlopen(req, timeout=30)`. Default socket timeout is None, so a stalled
  TCP connection hung the job indefinitely.
- `ci-pending/effort-issues-sync.yml`: STAGED (not active) workflow copy adding
  `timeout-minutes: 10` as a job-level backstop. The gh OAuth token lost its
  `workflow` scope (REST 404 + push rejection), so the workflow edit cannot be
  pushed by an agent. Owner step: `gh auth refresh -s workflow && cp
  ci-pending/effort-issues-sync.yml .github/workflows/ && git commit`. The
  script-level 30s timeout (this PR) alone fixes the observed hang; the job
  backstop is belt-and-braces.
- `docs/EFFORT-LOG.md` row + this note.

## Decisions & Trade-offs
- Did not retry-loop the sync: it is a read-only visibility mirror with a
  daily schedule and per-push triggers; a failed run is retried by the next
  trigger naturally.
- 30s is generous for the GitHub REST API from this runner; the job does a
  bounded number of requests (issues sync for one board file), so 10 min
  job-level headroom is ample.

## Verification State
- `python3 -c 'import ast; ast.parse(...)'` syntax check passes.
- Pattern-match edits verified unique (single occurrence each).
- Required `verify` CI gates the PR.
- Real confirmation: the next push-triggered `Effort Issues Sync` run on main
  completes in ~1 min instead of hanging.

## Next Steps & Blockers
- Merge on green verify (auto-merge armed); watch the next sync run.

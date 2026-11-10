# 2026-07-10 — Activity-feed audit close-out (MONET)

## Summary

Lands the owner-directed 3-day production Activity-feed audit's full verified
report at `docs/reviews/2026-07-09-activity-feed-audit.md` (36-agent workflow:
5 domain investigators over the prod DB + repo, adversarial verification per
finding, ranked synthesis), with a landing-status addendum covering the action
items that completed between the audit and this merge (bump-to-floor #1297,
the congress.trade whitelist, the 07-10 deploys) and two factual corrections
(`SEC_FILING_INGEST_TTL_HOURS` knob name; storage-warning direct-notify skip
set). Board mirror: audit + bump-to-floor rows recorded Completed (kept off
the code PRs to end the board-file conflict treadmill), the stale In Progress
audit row removed, and Planned rows added for the unclaimed P2/P3 backlog
(P1s + attribution sweep are claimed owner-directed by other lanes).

## Why

Close-out protocol for the audit reservation; the report doubles as the fix
backlog's spec. Review threads on the docs PR (#1305) drove the addendum,
corrections, Planned rows, stale-row removal, and this note.

## Files

- `docs/reviews/2026-07-09-activity-feed-audit.md` (new + addendum)
- `docs/EFFORT-LOG.md` (Completed rows, stale-row removal, Planned backlog)
- `STATUS.md`
- this note

## Verification

- Docs-only; `land.sh` gate (tsc/tests/build) green under node 24 on the code
  tree at branch time; `verify` CI gates the merge.

## Follow-ups

- The unclaimed P2/P3 backlog rows (above) — reserve before starting.

# 2026-08-17 — Pinecone trial is not the Starter 2M monthly wall

## Context & Objective

Owner: the app thinks monthly Pinecone write units are at the free-tier limit, and Pushover
is still firing for Litestream plus other leftover health noise.  Live Pinecone is a
Standard trial (~$300 credit through 2026-08-30).  That plan is usage-billed.  It does
not have the Starter 2M write-unit / month cap.

## Changes Made

The monthly write-unit breaker was built for the pre-trial Starter 429
(`current month (2000000)`).  After the trial opened, a leftover
`pinecone:wuExhaustedUntil` marker (or a fresh 2M-shaped 429) parked every
vector write until the 1st of next month.  The gate runs *before* any upsert, so
`notePineconeWriteSuccess` could never clear it.  Connections health then
annotated the lane as `monthly write units exhausted`.  A leftover
`PINECONE_MONTHLY_WU_BUDGET=2000000` (or the post-trial 1.6M snap) could also
page the monthly pace guard during the trial.

Litestream L0–L3/L9 are advancing again on prod (health 2026-08-17 21:35Z).
The remaining alert bug: the runtime-log scanner treated a healed
`compaction failed` line in the tail as a live failure and re-paged every 12h.

Public `/api/health` still listed retired FilingAPI as `ok: false` from stale
401 rows, which looks like a live outage to UptimeRobot / Pushover.

- Trial-active: ignore / clear the monthly WU breaker.  Do not trip on a
  Starter-shaped 429.  Monthly pace budget is 0 even if env still holds 2M.
- Trial assessment: `effectiveMonthlyWriteUnits` is always 0 while the trial
  is open.
- Litestream log scan: drop failures older than a later `compaction complete`
  for that level.
- Public health: omit intentional-off retired vendors (FilingAPI / FMP /
  Quiver / UW) from `checks.dependencies`.

Touched files:

- `src/lib/pinecone-wu-breaker.ts`
- `src/lib/pinecone-monthly-pace.ts`
- `src/lib/pinecone-trial-window.ts`
- `src/lib/scheduler.ts`
- `src/lib/runtime-health.ts`
- `app/api/health/route.ts`
- `test/pinecone-wu-breaker.test.ts`
- `test/pinecone-monthly-pace.test.ts`
- `test/pinecone-trial-window.test.ts`
- `test/runtime-health.test.ts`
- `test/connection-health-routing.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- Did not raise `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`.  The rolling-24h fuse
  is a separate burst cap and stays trial-aware.
- Did not change B2 objects.  Live L2/L3 were already advancing after the
  earlier L1 suffix work.
- Did not fetch Pinecone's org-month usage API.  The bug was the app applying
  the Starter 2M wall to a Standard trial, not a missing vendor total.

## Verification State

```bash
cd ~/apps/trading-cursor-pinecone-wu
./node_modules/.bin/vitest run \
  test/pinecone-wu-breaker.test.ts \
  test/pinecone-monthly-pace.test.ts \
  test/pinecone-trial-window.test.ts \
  test/runtime-health.test.ts \
  test/connection-health-routing.test.ts
# 5 files / 108 passed
```

Live `https://socratictrade.com/api/health` at triage: `ok`, Litestream
replicating, L0–L3/L9 not degraded, `litestreamCompactionLogFailureCount=0`,
`filingapi` still listed `ok: false` (this PR drops that row).

## Next Steps & Blockers

- After merge: confirm Connections no longer shows
  `monthly write units exhausted` and ingest resumes while the trial is open.
- After 2026-08-30 the existing free-tier snap (60k WU/day, 1.6M/month) still
  applies unless `PINECONE_TRIAL_ENDS_AT=off` or a new trial date is set.
- FilingAPI stays retired.  Do not mint a Plus key.

## Zero-Code Findings

- Prod release at triage was `b4666e74` (FilingAPI retirement already on the
  box).  Litestream tiers were healthy; the Pushover residue was the log
  scanner plus the Pinecone Starter latch, not a new L2 hole.

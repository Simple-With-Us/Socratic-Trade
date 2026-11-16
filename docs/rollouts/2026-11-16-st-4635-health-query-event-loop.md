# 2026-11-16 — ST-4635 health-lane, receipts and rag_usage event-loop holds

Linear: https://linear.app/simple-with-us/issue/ST-4635

## Context & Objective

On Mon Nov 16 2026, prod (983d7cef) held the Node event loop for 12 to 69 s at a time on synchronous SQLite reads against the 22 GB `app.db`.  During a hold `/api/health` cannot answer.  The host watchdog (`fleet-health-recover@socratic-app`: 30 s interval, 12 s curl timeout, 2 failures) restarted the container at 8:56:33am and 9:11:28am CT.  That killed the 8:46:59am scheduled Sandbox strategy run and its 9:01:54am retry ("Process restarted mid-run").  The watchdog restarted the app 12 to 38 times a day from Nov 12 to Nov 16, and on Nov 12, 23 runs were restart-killed against 6 completed.  This change removes the three worst holds seen in the container's `[slow-sqlite]` log.

## Changes Made

- **Health lanes (`src/lib/db-health.ts`).**  `listHealthLanes()` ran `SELECT DISTINCT service, key_source FROM api_health_log` (1.8M rows, lifetime retention) on every `/api/health` snapshot refresh and every scheduler tick.  On prod it held 15.9 to 18.8 s.  It now:
  - loads lanes with a loose index scan, a chain of `MIN()` seeks on `idx_api_health_log_service_key` / `_service_ts` (O(lanes × log rows));
  - caches the lane list per connection for `HEALTH_LANE_CACHE_TTL_MS` (default 5 min; 0 under Vitest, because tests insert rows with raw SQL);
  - updates the cache from `flushApiHealthBuffer` right after each committed batch, so a new lane appears at once.
  `listHealthServices()` derives from the same lanes.  The row data and the summaries (counts, streaks) are unchanged.
- **Managed vector receipts (`src/lib/db-vector-commits.ts`, `src/lib/vector-db.ts`).**  Retrieval can check up to 6 tiers × 10,000 candidate ids.  The old lookup ran every 900-id batch back to back on the serving thread and re-prepared a 900-placeholder statement each time.  One call held prod for 69 s.  Now:
  - full-size statements are cached per connection (at most four);
  - `committedManagedVectorReceiptsAsync` runs 200-id batches and yields (`setImmediate`) between them;
  - retrieval calls the new `filterMatchesForCommittedReceiptsAsync`, which shares a single planner with the sync `filterMatchesForCommittedReceipts`, so the admission predicate is literally the same code.  The sync function keeps its behavior for existing callers and tests.
- **rag_usage cursor index (`src/lib/db.ts`, migration 103).**  Adds `idx_rag_usage_created_id ON rag_usage (created_at, id)`.  The usage-monitor replay cursor page went from `SCAN rag_usage | USE TEMP B-TREE FOR ORDER BY` (11.7 to 15.9 s on prod) to `SEARCH ... USING COVERING INDEX idx_rag_usage_created_id (created_at>?)`.  The windowed reads also seek.  No query text changed.

Files:
- `src/lib/db-health.ts`
- `src/lib/db-vector-commits.ts`
- `src/lib/vector-db.ts`
- `src/lib/db.ts`
- `test/health-lane-cache.test.ts` (new)
- `test/rag-usage-cursor-index.test.ts` (new)
- `test/vector-db-document-receipts.test.ts`
- `test/vector-db-chunk-cap.test.ts` (mock gains the async lookup)
- `STATUS.md`, `PLAN.md`, this note

## Decisions & Trade-offs

- **No api_health_log pruning.**  `sqlite-storage-hygiene.ts` records it as lifetime retention on purpose (2026-10-15).  Changing that is an owner decision, not part of this fix.
- **Cache staleness.**  The only production writer refreshes the cache itself.  The one other deleter, account deletion, can leave a lane listed for up to one TTL after its last row is gone.  That lane then shows zero calls, which is harmless.
- **Index build cost.**  On a local 1.4M-row copy (468 MB, warm cache), `CREATE INDEX` took 0.8 s.  Prod is I/O-starved: host swap is 24 of 32 GB, and the DB is 22 GB.  Expect the build to take 10 to 60 s on prod.  It runs in the boot migration transaction (`BEGIN IMMEDIATE`, write lock held), the same class as v100 (audit_events, 1.4M rows).  Auto-deploy's weekday RTH latch puts it after the close.  The host watchdog skips checks while a Coolify deployment is active.
- **Money path untouched.**  There is no order, sizing, risk-gate or strategy-logic change.  Retrieval admits exactly the same managed matches.

## Verification State

- `npx tsc --noEmit`: clean.
- `npx eslint <touched files>`: 0 errors (pre-existing warnings only).
- `npx vitest run test/health-lane-cache.test.ts test/rag-usage-cursor-index.test.ts test/vector-db-document-receipts.test.ts test/vector-db-chunk-cap.test.ts test/health-*.test.ts test/usage-monitor-replay.test.ts test/vector-db-*.test.ts test/rag-*.test.ts ...` (25 files): 319 passed, 12 skipped.
- Full `npx vitest run`: see the PR body.
- Local micro-benchmark (1.8M api_health_log rows, 120 lanes): DISTINCT 103 ms against the loose scan's 0.87 ms.

## Next Steps & Blockers

- After deploy, check the container log for `[db] applied migration 103` and its timing, and confirm the `[slow-sqlite]` lines for these three statements are gone.
- Then watch the `fleet-health-recover@socratic-app` restart count and `strategy_runs` "Process restarted mid-run" rows during RTH.
- The host watchdog threshold and probe target are a separate owner decision and are not touched here.
- Other remaining holds in the same log: vector-commit receipt-persist transactions (2.4 to 6.9 s) and `historical_fundamentals` inserts (6 s).

## Zero-Code Findings

- Monitor's "Friday had no runs" premise was wrong: Nov 13 2026 was the Friday.  The last completed run was 2:23pm CT Fri Nov 13, and the 2:51pm run was restart-killed at the 3:00pm close.

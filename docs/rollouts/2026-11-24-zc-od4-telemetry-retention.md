# 2026-11-24 [ZC] ST-4681 OD-4: FIFO retention for operational telemetry

## 1. Context & Objective

OD-4 (owner-approved Tue, Nov 24, 2026, child of ST-4668) authorizes bounded FIFO retention
for operational telemetry ONLY.  This note lands the three in-scope sweeps so the shared box's
SQLite/R2 volume stops growing without bound on pure observability rows.  Keep-forever tables
(audit_events, llm_usage, rag_usage, strategy_runs, portfolio_snapshots, headline_first_seen,
task_journal, and all learning tables) are untouched.

## 2. Changes Made

- New module `src/lib/db-telemetry-retention.ts` mirroring the api_health_log template
  (`src/lib/db-health-retention.ts`, ST-4644) exactly: per-sweep due-watermark (10 min), env knob
  where `0` disables, 2,000-row bounded batches with an event-loop yield between them (the
  ST-4635 hard constraint), and one log line per due run.
- Sweeps implemented:
  - `provider_dispatch_attempts` — 30d FIFO on `created_at`
    (env `PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS`).  Predicate:
    `created_at IS NOT NULL AND created_at < cutoff ORDER BY created_at ASC LIMIT 2000`,
    index-served by the existing `idx_pda_created_at` (added for retention pruning by
    migration v65).
  - `provider_usage_outbox` — 14d FIFO on `created_at` (env `PROVIDER_USAGE_OUTBOX_RETENTION_DAYS`)
    restricted to rows that are BOTH settled AND provably delivered.  Settled: the schema CHECK
    `outcome IN ('succeeded','failed','unknown')` and the writers (`insertUsageOutbox` is called
    only from `settleProviderDispatch` and the lease-expiry reconcile path in
    `src/lib/db-provider-dispatch.ts`) mean every row is a terminal outcome; the predicate still
    names the three outcomes explicitly so a future CHECK widening can never make the sweep touch
    a pending row.  Delivered: Usage Monitor replay (`src/lib/usage-monitor-replay.ts`) advances
    its settings-table watermark to the last row of an acknowledged, fully closed window.  The
    sweep deletes only rows with `created_at < min(windowCutoff, watermark.createdAt)`, and with
    no valid watermark it deletes NOTHING (fail closed; a corrupt/absent cursor counts as
    never-delivered).  Index-served by the existing `idx_puo_created_at`.
  - `sec_ingest_task_attempts` — 30d FIFO on `finished_at` (env
    `SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS`).  Predicate:
    `finished_at IS NOT NULL AND finished_at < cutoff` — ageing on completion time means an
    in-flight/unfinished attempt (NULL `finished_at`) is never deleted however ancient its
    `started_at`.  New migration v105 adds `idx_sita_finished_at` so batches stay index-served.
- `notification_events` — **NOT swept**, skipped with evidence (see Zero-Code Findings).
- Wiring (no `src/lib/scheduler.ts` edit): the scheduler's single periodic entry for this lane
  is `runApiHealthLogRetentionIfDue()` (`src/lib/db-health-retention.ts`, called from
  `src/lib/scheduler.ts` inside `journalLane("api-health-log-retention", ...)`).  Its body now
  first awaits `runOd4TelemetryRetentionIfDue()` (independent try/catch; the sibling sweeps have
  their own watermarks so they run even when the api_health_log lane itself is not due), then the
  original api_health_log logic unchanged.  The return value stays api_health-log-only, so the
  journal summary semantics are preserved.
- `src/lib/db.ts`: migration v105 (`sec_ingest_task_attempts_finished_at_index`), purely additive.

Files touched:
- `src/lib/db-telemetry-retention.ts` (new)
- `src/lib/db-health-retention.ts` (header comment + entry wiring)
- `src/lib/db.ts` (v105 index migration)
- `test/od4-telemetry-retention.test.ts` (new)
- `STATUS.md`, this note

## 3. Decisions & Trade-offs

- dispatch_attempts is a pure age FIFO (no status predicate), per the task scope: 30 days is far
  past any live lease (dispatch leases are minutes and reconcile closes stragglers to `unknown`),
  and the quota/cost/idempotency queries are all bounded to at most 24h windows.  A 30-day-old
  row cannot influence a future admission decision.
- The outbox delivery proof uses the replay watermark rather than assuming replay is healthy;
  the provider lane was never live-pushed, so an old/wedged watermark legitimately blocks
  deletion until delivery catches up.  The watermark-key literal is pinned to
  `USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider` by a test (kept local to avoid importing the
  lazy-loaded replay module's dependency graph into the db layer).
- `getInternalSetting` JSON-parses, so the cursor arrives pre-parsed; the reader validates shape
  and treats garbage as "never delivered".
- No-op prune hooks (`src/lib/audit-prune.ts:99`, `src/lib/db-task-journal.ts:272`) left as-is —
  these sweeps are periodic, not lazy-hook shaped, and the api_health_log precedent is the
  scheduler lane.

## 4. Verification State

- `npm run lint` — 0 errors (915 pre-existing grandfathered warnings).
- `npx vitest run test/od4-telemetry-retention.test.ts` — 23 passed (old rows deleted, fresh
  kept, NULL-finished kept, outbox settled+delivered rule incl. CHECK-rejects-pending proof,
  watermark due-once-per-window, env override + `0` disables, bounded oldest-first batches,
  EXPLAIN shows all three batch DELETEs index-served with no table scan, aggregate entry drives
  all sweeps through the untouched scheduler call site).
- `npx vitest run test/api-health-log-retention.test.ts` — 8 passed (template behavior
  unchanged by the wiring).
- `npx vitest run test/db-migration-old-schema.test.ts test/db-migration-busy.test.ts` and
  `test/provider-dispatch-durability.test.ts test/usage-monitor-replay.test.ts
  test/sec-ingest-worker.test.ts` — all green (88 tests in the second batch).
- `npx tsc --noEmit`, `npm run build`, full `npm test`: NOT run here (shared production box;
  the lead runs the serialized full gate).

## 5. Next Steps & Blockers

- Lead runs the full gate on this branch and lands it.
- Follow-up for lane zc-4677 (owner of `src/lib/sqlite-storage-hygiene.ts`, NOT edited here):
  its table labels still describe `provider_usage_outbox` as "lifetime provider usage outbox
  retention" (line ~111) and its class map marks it `logs` (line ~137) — both should be updated
  to reflect OD-4's 14d delivered-row retention, and `provider_dispatch_attempts` /
  `sec_ingest_task_attempts` labels checked for the same drift.
- Follow-up (CODEOWNERS money path, not edited here): the `src/lib/scheduler.ts` comment block
  above the `api-health-log-retention` lane (~lines 1041-1048) still says
  `provider_usage_outbox` / `provider_dispatch_attempts` are deliberately NOT swept — that is now
  stale; a maintainer should reword it to reference `runOd4TelemetryRetentionIfDue`.

## 6. Zero-Code Findings

- **notification_events is skipped — the delivery-telemetry-vs-user-visible split is not
  provable.**  Evidence: the schema (`src/lib/db.ts` baseline `CREATE TABLE notification_events`
  + later migrations adding `user_id`, `connected_account_id`, `acknowledged_at`) has NO
  delivery-only partition: `status` is the per-row delivery result
  (`NotificationStatus = "sent" | "failed" | "skipped"`, `src/lib/types.ts:147`) on the SAME rows
  that ARE the user-visible alerts.  `src/lib/notification-delivery.ts:3` states it directly:
  "One notification_events row is one attempted send" — the delivery ledger IS the Activity
  Notifications tab.  `listNotificationEvents` (`src/lib/db-notifications.ts:~237`) feeds every
  row to the UI, and the run_failed dedupe comment says acknowledged history "stays visible
  under 'All'" — i.e. old rows are user-visible history by design.  The existing sweeps
  (`acknowledgeAllNotificationEvents`, `sweepAutoAcknowledgeNotifications`) deliberately UPDATE
  (`acknowledged_at`) rather than DELETE for exactly this reason.  Deleting "delivery rows" would
  therefore delete user-visible notification state, which OD-4 forbids.  This table needs its
  own owner ruling (e.g. "delete only acknowledged_at IS NOT NULL AND acknowledged 30d ago")
  before any sweep is safe.

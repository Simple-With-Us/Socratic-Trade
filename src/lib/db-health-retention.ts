// db-health-retention.ts — bounded FIFO retention for api_health_log.
//
// ST-4644 (audit F2 in docs/audits/2026-11-21-zc-backend-perf.md).
//
// The 2026-10-15 keep-everything policy removed every age-based DELETE.  That was right for
// the DURABLE decision records, but `api_health_log` is append-only OBSERVABILITY: it had
// grown to ~1.8M rows by 2026-11-16, and one un-indexed query shape over it held the event
// loop 15.9-18.8s and got the container watchdog-restarted (ST-4635).  Growth compounds disk
// usage, index-maintenance cost, and the Litestream R2 volume on a box shared with two other
// apps.
//
// The owner instruction "implement all improvements identified" (2026-11-23) is the
// authorization for the retention decision this issue was parked on.  It covers THIS TABLE.
// Separately, OD-4 (owner-approved Tue, Nov 24, 2026, ST-4681) authorized FIFO retention for
// three more operational-telemetry tables, swept from runOd4TelemetryRetentionIfDue() below
// (see db-telemetry-retention.ts).  The remaining insert-only observability tables —
// `llm_usage`, `rag_usage`, `headline_first_seen` — stay untouched: their retention is still
// a separate owner decision.
//
// What makes FIFO safe here: the durable hard-failure streak state was deliberately moved OUT
// of this table (db-health.ts's `DurableHardStreak` in the settings table) precisely so the
// log could be truncated without losing the escalation signal.
//
// HARD CONSTRAINT (from the ST-4635 incident): the sweep must NEVER run one big DELETE on the
// event loop.  It deletes in bounded batches and yields the event loop between them, exactly
// like the notification sweeps (db-notifications.ts's SWEEP_BATCH_LIMIT pattern).  The oldest
// rows are picked through `idx_api_health_log_ts` (ts ASC), so each batch is an index range
// scan, not a table scan.

import { getDb } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { runOd4TelemetryRetentionIfDue } from "./db-telemetry-retention";
import { yieldEventLoop } from "./slow-sync-guard";

/**
 * Default retention window.  30 days is the audit's conservative low end: long enough that
 * every recent-failure investigation still has the raw log behind it, short enough that the
 * table stops growing without bound.
 */
export const API_HEALTH_LOG_RETENTION_DAYS_DEFAULT = 30;

/** `API_HEALTH_LOG_RETENTION_DAYS` overrides the window.  `0` disables the sweep entirely. */
export function apiHealthLogRetentionDays(): number {
  const raw = process.env.API_HEALTH_LOG_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return API_HEALTH_LOG_RETENTION_DAYS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return API_HEALTH_LOG_RETENTION_DAYS_DEFAULT;
  return parsed;
}

/** Rows deleted per batch.  Bounded so one batch is a short, index-served statement. */
export const API_HEALTH_LOG_SWEEP_BATCH_LIMIT = 2_000;

/** Batches per run.  20 x 2000 = 40k rows per pass — the run yields between batches. */
export const API_HEALTH_LOG_SWEEP_MAX_BATCHES = 20;

/** How often the sweep is allowed to run. */
const RETENTION_INTERVAL_MS = 10 * 60_000;
const LAST_RUN_KEY = "apihealthlogretention:lastRunAt";

/** Cutoff timestamp (ISO) before which rows are eligible for deletion. */
export function apiHealthLogRetentionCutoff(now: number = Date.now(), days = apiHealthLogRetentionDays()): string {
  return new Date(now - days * 24 * 60 * 60_000).toISOString();
}

/**
 * Delete ONE bounded batch of the oldest rows older than `cutoffIso`.
 *
 * The rowids come from an index range scan on `ts` (idx_api_health_log_ts) limited to
 * `batchLimit`, so this never scans the whole table.  Returns the number of rows deleted.
 */
export function sweepApiHealthLogBatch(cutoffIso: string, batchLimit = API_HEALTH_LOG_SWEEP_BATCH_LIMIT): number {
  const result = getDb()
    .prepare(
      `DELETE FROM api_health_log WHERE rowid IN (
         SELECT rowid FROM api_health_log WHERE ts < ? ORDER BY ts ASC LIMIT ?
       )`
    )
    .run(cutoffIso, batchLimit);
  return result.changes;
}

/**
 * Sweep api_health_log down to the retention window, in bounded batches, yielding the event
 * loop between them.  Returns the total number of rows deleted.
 *
 * NOTE: the health LANE cache (db-health.ts) is deliberately NOT invalidated here.  The lane
 * list is a superset of "services with recent rows"; dropping it here would make a lane
 * disappear from the panel the moment its last old row was deleted.  The cache's own TTL
 * reloads it in the background, which is the safe path.
 */
export async function sweepApiHealthLogRetention(
  now: number = Date.now(),
  days = apiHealthLogRetentionDays()
): Promise<number> {
  if (days <= 0) return 0; // retention disabled by configuration
  const cutoffIso = apiHealthLogRetentionCutoff(now, days);
  let deleted = 0;
  for (let batch = 0; batch < API_HEALTH_LOG_SWEEP_MAX_BATCHES; batch++) {
    const changes = sweepApiHealthLogBatch(cutoffIso);
    deleted += changes;
    if (changes < API_HEALTH_LOG_SWEEP_BATCH_LIMIT) break; // drained
    // Yield between batches so a big backlog never pins the event loop (ST-4635).
    await yieldEventLoop();
  }
  return deleted;
}

/** True when the sweep is due (never run before, or the interval has elapsed). */
export function isApiHealthLogRetentionDue(now: number = Date.now()): boolean {
  try {
    const last = getInternalSetting<string>(LAST_RUN_KEY);
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return true;
    return now - lastMs >= RETENTION_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * Run the sweep when it is due.  Returns the number of rows deleted, or null when the sweep
 * was not due.  Never throws: retention is housekeeping and must not break a scheduler tick.
 *
 * ST-4681 (OD-4): this is ALSO the scheduler's single periodic entry for the OD-4 telemetry
 * sweeps (provider_dispatch_attempts / provider_usage_outbox / sec_ingest_task_attempts).
 * They have their own due-watermarks and error isolation, so they keep running even when the
 * api_health_log lane itself is not due, and the return value stays api_health_log-only.
 */
export async function runApiHealthLogRetentionIfDue(now: number = Date.now()): Promise<number | null> {
  // Independent try/catch so a telemetry sweep can never suppress the api_health_log lane
  // (and runOd4TelemetryRetentionIfDue itself never throws).
  try {
    await runOd4TelemetryRetentionIfDue(now);
  } catch (err) {
    console.error("[od4-telemetry-retention] sweep error:", err instanceof Error ? err.message : err);
  }
  try {
    if (!isApiHealthLogRetentionDue(now)) return null;
    const deleted = await sweepApiHealthLogRetention(now);
    // The watermark is written AFTER the sweep, so a failed sweep leaves the lane due and the
    // backlog is retried on the next tick instead of being suppressed for the whole interval.
    setInternalSetting(LAST_RUN_KEY, new Date(now).toISOString());
    return deleted;
  } catch (err) {
    console.error("[api-health-log-retention] sweep error:", err instanceof Error ? err.message : err);
    return null;
  }
}

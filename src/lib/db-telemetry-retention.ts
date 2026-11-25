// db-telemetry-retention.ts — bounded FIFO retention for operational telemetry.
//
// ST-4681 (OD-4, owner-approved Tue, Nov 24, 2026): FIFO retention for operational telemetry
// ONLY.  The owner-approved scope is exactly these tables:
//   - provider_dispatch_attempts  (30d, PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS)
//   - provider_usage_outbox       (14d, PROVIDER_USAGE_OUTBOX_RETENTION_DAYS, delivered-only)
//   - sec_ingest_task_attempts    (30d, SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS)
//
// Keep-forever tables this module MUST NEVER touch: audit_events, llm_usage, rag_usage,
// strategy_runs, portfolio_snapshots, headline_first_seen, task_journal, and all learning
// tables.  notification_events is deliberately NOT swept: every row is a user-visible
// alert-center / Activity Notifications row that doubles as its own delivery ledger entry —
// the delivery-telemetry-vs-user-visible split is not provable.  Evidence + reasoning:
// docs/rollouts/2026-11-24-zc-od4-telemetry-retention.md (Zero-Code Finding).
//
// Every sweep mirrors the api_health_log template (db-health-retention.ts, ST-4644) exactly:
// a due-watermark (10 min), an env knob where 0 disables, 2,000-row bounded batches served by
// a created_at/finished_at index, an event-loop yield between batches (the ST-4635 hard
// constraint), and one log line per run.  Rows with a NULL age timestamp can never match a
// `col < cutoff` comparison and are additionally guarded explicitly where the column is
// nullable, so in-flight rows are never deleted.
//
// Wiring: runApiHealthLogRetentionIfDue() in db-health-retention.ts is the ONE exported
// periodic entry the scheduler already calls (scheduler.ts, journalLane
// "api-health-log-retention").  It invokes runOd4TelemetryRetentionIfDue() from this module,
// so no scheduler.ts edit is needed.

import { getDb } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { yieldEventLoop } from "./slow-sync-guard";

/** Rows deleted per batch — same bound as the api_health_log template. */
export const TELEMETRY_SWEEP_BATCH_LIMIT = 2_000;

/** Batches per run.  20 x 2000 = 40k rows per pass — the run yields between batches. */
export const TELEMETRY_SWEEP_MAX_BATCHES = 20;

/** How often each sweep is allowed to run (same cadence as the api_health_log lane). */
const RETENTION_INTERVAL_MS = 10 * 60_000;

/**
 * `0` disables a sweep entirely; a missing/invalid value falls back to the default.
 * Mirrors apiHealthLogRetentionDays() byte-for-byte in shape.
 */
/**
 * Upper bound (10 years). Days beyond this would push `now - days*86_400_000` outside the Date
 * range and throw RangeError inside telemetryRetentionCutoff, stalling the sweep forever; a
 * fraction is floored so the whole-day contract holds. Env parsing AND the cutoff builder both
 * clamp so no caller path can overflow the Date constructor.
 */
const RETENTION_DAYS_MAX = 3650;

export function telemetryRetentionDaysFromEnv(envName: string, defaultDays: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return defaultDays;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultDays;
  return Math.min(Math.floor(parsed), RETENTION_DAYS_MAX);
}

/** Cutoff ISO timestamp `days` before `now` (ISO strings compare correctly). Clamped defensively. */
export function telemetryRetentionCutoff(now: number, days: number): string {
  const safeDays = Math.min(Math.max(Math.floor(Number.isFinite(days) ? days : 0), 0), RETENTION_DAYS_MAX);
  return new Date(now - safeDays * 24 * 60 * 60_000).toISOString();
}

/** True when the sweep is due (never run before, or the interval has elapsed). */
function isSweepDue(lastRunKey: string, now: number = Date.now()): boolean {
  try {
    const last = getInternalSetting<string>(lastRunKey);
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return true;
    return now - lastMs >= RETENTION_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * Loop ONE sweep's bounded batches until drained or the per-run cap, yielding between batches.
 * `runBatch` must delete at most `batchLimit` of the OLDEST eligible rows and return the count.
 */
async function sweepBatches(
  runBatch: (batchLimit: number) => number,
  maxBatches = TELEMETRY_SWEEP_MAX_BATCHES
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const changes = runBatch(TELEMETRY_SWEEP_BATCH_LIMIT);
    deleted += changes;
    if (changes < TELEMETRY_SWEEP_BATCH_LIMIT) break; // drained
    // Yield between batches so a big backlog never pins the event loop (ST-4635).
    await yieldEventLoop();
  }
  return deleted;
}

/** Run `sweep` when due, stamp the watermark after it, and log one line.  Never throws. */
async function runDueSweep(
  label: string,
  lastRunKey: string,
  now: number,
  sweep: () => Promise<number>
): Promise<number | null> {
  try {
    if (!isSweepDue(lastRunKey, now)) return null;
    const deleted = await sweep();
    // Watermark AFTER the sweep (template rule): a failed sweep leaves the lane due so the
    // backlog is retried on the next tick instead of being suppressed for the whole interval.
    setInternalSetting(lastRunKey, new Date(now).toISOString());
    console.log(`[${label}] deleted=${deleted}`);
    return deleted;
  } catch (err) {
    console.error(`[${label}] sweep error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. provider_dispatch_attempts — 30d FIFO on created_at (idx_pda_created_at).
// ---------------------------------------------------------------------------
// The ledger's durable purpose (idempotency replay, quota windows, cost caps) is all
// time-scoped: the reserve() queries sum units/cost over windows of at most 24h and replay is
// keyed on rows the same request would have just written.  A 30-day-old attempt — settled,
// cancelled, or reconciled-to-unknown long before any lease could still be live — is pure
// operational telemetry.  created_at is NOT NULL in the schema, so no row can slip the guard.

export const PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS_DEFAULT = 30;
const PROVIDER_DISPATCH_ATTEMPTS_LAST_RUN_KEY = "providerdispatchattempts:lastRunAt";

export function providerDispatchAttemptsRetentionDays(): number {
  return telemetryRetentionDaysFromEnv(
    "PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS",
    PROVIDER_DISPATCH_ATTEMPTS_RETENTION_DAYS_DEFAULT
  );
}

export function providerDispatchAttemptsRetentionCutoff(
  now: number = Date.now(),
  days = providerDispatchAttemptsRetentionDays()
): string {
  return telemetryRetentionCutoff(now, days);
}

/**
 * DELETE ONE bounded batch of the oldest attempts older than `cutoffIso`. Rows that
 * `account-deletion.ts` counts as ACTIVE provider dispatches (`reserved`, `dispatched`, or
 * `unknown` + `stale-owner-unresolved`) are NEVER deleted regardless of age — the deletion gate
 * treats them as pending money-path accounting with no time bound, so pruning them would silently
 * drop a user's account-deletion block. Settled/cancelled/failed rows and fully reconciled unknowns
 * are pure telemetry and age out normally.
 */
export function sweepProviderDispatchAttemptsBatch(
  cutoffIso: string,
  batchLimit = TELEMETRY_SWEEP_BATCH_LIMIT
): number {
  const result = getDb()
    .prepare(
      `DELETE FROM provider_dispatch_attempts WHERE rowid IN (
         SELECT rowid FROM provider_dispatch_attempts
         WHERE created_at IS NOT NULL AND created_at < ?
           AND NOT (
             status IN ('reserved','dispatched')
             OR (status = 'unknown' AND outcome_code = 'stale-owner-unresolved')
           )
         ORDER BY created_at ASC LIMIT ?
       )`
    )
    .run(cutoffIso, batchLimit);
  return result.changes;
}

export async function sweepProviderDispatchAttemptsRetention(
  now: number = Date.now(),
  days = providerDispatchAttemptsRetentionDays()
): Promise<number> {
  if (days <= 0) return 0; // retention disabled by configuration
  const cutoffIso = providerDispatchAttemptsRetentionCutoff(now, days);
  return sweepBatches((limit) => sweepProviderDispatchAttemptsBatch(cutoffIso, limit));
}

export async function runProviderDispatchAttemptsRetentionIfDue(
  now: number = Date.now()
): Promise<number | null> {
  return runDueSweep(
    "provider-dispatch-attempts-retention",
    PROVIDER_DISPATCH_ATTEMPTS_LAST_RUN_KEY,
    now,
    () => sweepProviderDispatchAttemptsRetention(now)
  );
}

// ---------------------------------------------------------------------------
// 2. provider_usage_outbox — 14d FIFO on created_at (idx_puo_created_at), DELIVERED rows only.
// ---------------------------------------------------------------------------
// Two rules, both provable from this module's own reads:
//
// (a) SETTLED only.  The outbox has no delivery-state column: rows are inserted exclusively by
//     insertUsageOutbox() (db-provider-dispatch.ts), which runs only inside settleProviderDispatch
//     and the lease-expiry reconcile path — i.e. after the attempt reached a terminal outcome —
//     and the schema CHECK constrains `outcome` to ('succeeded','failed','unknown'), all terminal.
//     A row that could not exist by construction today is still refused by the explicit predicate,
//     so a future writer relaxation cannot make the sweep delete a pending row.
//
// (b) DELIVERED only.  Usage Monitor replay (usage-monitor-replay.ts) is the outbox's only
//     consumer; it groups whole closed windows [startIso, endIso), sends them, and advances the
//     settings-table watermark cursor to the LAST row of the acknowledged window only after the
//     send is acknowledged (a collision-skip is itself proof of prior delivery).  created_at can
//     never be backdated (the writer stamps settlement time), so any row with
//     created_at < watermark.createdAt lay in an already-delivered window.  With no valid
//     watermark the sweep deletes NOTHING (fail-closed: nothing is provably delivered).
//
// The effective cutoff is min(retention window cutoff, watermark.createdAt); rows at or after
// the watermark are pending/unsent and are never deleted.

export const PROVIDER_USAGE_OUTBOX_RETENTION_DAYS_DEFAULT = 14;
const PROVIDER_USAGE_OUTBOX_LAST_RUN_KEY = "providerusageoutbox:lastRunAt";

/**
 * Settings key of the Usage Monitor replay watermark for this ledger.  Duplicated from
 * USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider (usage-monitor-replay.ts) because that module is
 * deliberately lazy-imported at startup (background-worker-startup.ts) and this retention module
 * must not drag its dependency graph into the db layer; the equality is pinned by a test.
 */
export const PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY =
  "usage_monitor_replay:provider_usage_outbox:watermark:v1";

/** Terminal dispatch outcomes — every outbox row is one settled attempt's usage record. */
const OUTBOX_TERMINAL_OUTCOMES = ["succeeded", "failed", "unknown"] as const;

export function providerUsageOutboxRetentionDays(): number {
  return telemetryRetentionDaysFromEnv(
    "PROVIDER_USAGE_OUTBOX_RETENTION_DAYS",
    PROVIDER_USAGE_OUTBOX_RETENTION_DAYS_DEFAULT
  );
}

/**
 * The delivered-through watermark cursor as an ISO created_at bound, or null when the replay
 * lane has never acknowledged anything (corrupt/missing value counts as never acknowledged).
 */
export function providerUsageOutboxDeliveredThrough(now: number = Date.now()): string | null {
  try {
    // Replay writes the cursor with raw SQL as a JSON object; getInternalSetting JSON-parses the
    // stored value, so it arrives already parsed (a string would be a corrupt shape -> null).
    const parsed = getInternalSetting<{ createdAt?: unknown; id?: unknown }>(
      PROVIDER_USAGE_OUTBOX_REPLAY_WATERMARK_KEY
    );
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0) return null;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    if (!Number.isFinite(Date.parse(parsed.createdAt))) return null;
    return new Date(parsed.createdAt).toISOString();
  } catch {
    return null;
  }
}

/**
 * Effective delete bound: older than the retention window AND strictly before the delivered
 * watermark.  Returns null when nothing is provably deletable (disabled, or no watermark).
 */
export function providerUsageOutboxEffectiveCutoff(
  now: number = Date.now(),
  days = providerUsageOutboxRetentionDays()
): string | null {
  if (days <= 0) return null;
  const delivered = providerUsageOutboxDeliveredThrough();
  if (!delivered) return null;
  const windowCutoff = telemetryRetentionCutoff(now, days);
  return windowCutoff < delivered ? windowCutoff : delivered;
}

/** DELETE ONE bounded batch of settled, delivered outbox rows older than `cutoffIso`. */
export function sweepProviderUsageOutboxBatch(
  cutoffIso: string,
  batchLimit = TELEMETRY_SWEEP_BATCH_LIMIT
): number {
  const placeholders = OUTBOX_TERMINAL_OUTCOMES.map(() => "?").join(", ");
  const result = getDb()
    .prepare(
      `DELETE FROM provider_usage_outbox WHERE rowid IN (
         SELECT rowid FROM provider_usage_outbox
         WHERE created_at IS NOT NULL AND created_at < ?
           AND outcome IN (${placeholders})
         ORDER BY created_at ASC LIMIT ?
       )`
    )
    .run(cutoffIso, ...OUTBOX_TERMINAL_OUTCOMES, batchLimit);
  return result.changes;
}

export async function sweepProviderUsageOutboxRetention(
  now: number = Date.now(),
  days = providerUsageOutboxRetentionDays()
): Promise<number> {
  const cutoffIso = providerUsageOutboxEffectiveCutoff(now, days);
  if (!cutoffIso) return 0; // disabled, or nothing provably delivered
  return sweepBatches((limit) => sweepProviderUsageOutboxBatch(cutoffIso, limit));
}

export async function runProviderUsageOutboxRetentionIfDue(
  now: number = Date.now()
): Promise<number | null> {
  return runDueSweep(
    "provider-usage-outbox-retention",
    PROVIDER_USAGE_OUTBOX_LAST_RUN_KEY,
    now,
    () => sweepProviderUsageOutboxRetention(now)
  );
}

// ---------------------------------------------------------------------------
// 3. sec_ingest_task_attempts — 30d FIFO on finished_at, finished attempts only.
// ---------------------------------------------------------------------------
// One row per ingest-task attempt (db-rag-ingest.ts claim writer).  started_at/heartbeat_at are
// stamped when the attempt begins; finished_at is written when the attempt ends and is NULL while
// the attempt is still live.  Ageing on finished_at (never started_at) means an in-flight or
// wedged-but-renewing attempt cannot be deleted, and the explicit NULL guard means unfinished
// attempts — however ancient — are always kept.  The task row itself (sec_ingest_tasks) and its
// FK cascade are untouched; this prunes only the per-attempt history of closed attempts.

export const SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS_DEFAULT = 30;
const SEC_INGEST_TASK_ATTEMPTS_LAST_RUN_KEY = "secingesttaskattempts:lastRunAt";

export function secIngestTaskAttemptsRetentionDays(): number {
  return telemetryRetentionDaysFromEnv(
    "SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS",
    SEC_INGEST_TASK_ATTEMPTS_RETENTION_DAYS_DEFAULT
  );
}

export function secIngestTaskAttemptsRetentionCutoff(
  now: number = Date.now(),
  days = secIngestTaskAttemptsRetentionDays()
): string {
  return telemetryRetentionCutoff(now, days);
}

/** DELETE ONE bounded batch of the oldest FINISHED attempts older than `cutoffIso`. */
export function sweepSecIngestTaskAttemptsBatch(
  cutoffIso: string,
  batchLimit = TELEMETRY_SWEEP_BATCH_LIMIT
): number {
  const result = getDb()
    .prepare(
      `DELETE FROM sec_ingest_task_attempts WHERE rowid IN (
         SELECT rowid FROM sec_ingest_task_attempts
         WHERE finished_at IS NOT NULL AND finished_at < ?
         ORDER BY finished_at ASC LIMIT ?
       )`
    )
    .run(cutoffIso, batchLimit);
  return result.changes;
}

export async function sweepSecIngestTaskAttemptsRetention(
  now: number = Date.now(),
  days = secIngestTaskAttemptsRetentionDays()
): Promise<number> {
  if (days <= 0) return 0; // retention disabled by configuration
  const cutoffIso = secIngestTaskAttemptsRetentionCutoff(now, days);
  return sweepBatches((limit) => sweepSecIngestTaskAttemptsBatch(cutoffIso, limit));
}

export async function runSecIngestTaskAttemptsRetentionIfDue(
  now: number = Date.now()
): Promise<number | null> {
  return runDueSweep(
    "sec-ingest-task-attempts-retention",
    SEC_INGEST_TASK_ATTEMPTS_LAST_RUN_KEY,
    now,
    () => sweepSecIngestTaskAttemptsRetention(now)
  );
}

// ---------------------------------------------------------------------------
// Aggregate entry — called from runApiHealthLogRetentionIfDue (db-health-retention.ts) so the
// scheduler's single periodic "api-health-log-retention" lane drives all of it.  Each sweep is
// independently due-gated (own watermark) and error-isolated; this function never throws.
// ---------------------------------------------------------------------------

export async function runOd4TelemetryRetentionIfDue(now: number = Date.now()): Promise<void> {
  await runProviderDispatchAttemptsRetentionIfDue(now);
  await runProviderUsageOutboxRetentionIfDue(now);
  await runSecIngestTaskAttemptsRetentionIfDue(now);
}

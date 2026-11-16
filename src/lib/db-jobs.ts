// db-jobs.ts — durable due-jobs substrate (generic claimable job queue).
//
// Built so time-based work (starting with 15m/1h intraday outcome sampling, see
// outcome-horizons.ts) survives process downtime instead of depending on a strategy run
// coincidentally landing inside a narrow sampling window. mobile_commands (db.ts migration v8,
// mobile-api.ts) is the closest existing precedent but has no lease/reclaim: a crashed 'running'
// row there is stuck forever. This table fixes that with claimed_by + lease_expires_at so a
// claim past its lease is reclaimable by the next drain pass.
//
// Concurrency model: like acquireStrategyLock (db-execution.ts) and the scheduler lease
// (scheduler-lease.ts), atomicity comes from a database.transaction() (single-writer SQLite +
// WAL) plus a conditional UPDATE ... WHERE that re-checks the claim predicate — a lost race
// leaves `changes !== 1` and the caller treats the row as already taken. Fails closed: any
// unexpected error during claim is treated as "not claimed" rather than assumed successful.
import "server-only";
import crypto from "crypto";
import { getDb } from "./db";

// NOTE: no 'failed' status — a job never sits permanently "failed". failDueJob only ever
// transitions a claimed row to 'pending' (retry) or terminally 'unresolvable' (exhausted/deadline);
// nothing in this substrate persists a 'failed' row, so the CHECK constraint (db.ts's due_jobs v11
// migration) and this union both omit it. Review finding #3: the drain receipt's separate
// "erroredRetried" counter (outcome-engine.ts) is a per-pass count of caught exceptions, not a
// per-job terminal status — do not conflate the two.
export type DueJobStatus = "pending" | "claimed" | "done" | "unresolvable";

export interface DueJobRecord {
  id: string;
  jobType: string;
  dedupeKey?: string;
  dueAt: string;
  notAfter?: string;
  status: DueJobStatus;
  payload: Record<string, unknown>;
  claimedBy?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  attempts: number;
  lastError?: string;
  result?: unknown;
  userId?: string;
  connectedAccountId?: string;
  createdAt: string;
  updatedAt: string;
}

type RawDueJobRow = {
  id: string;
  job_type: string;
  dedupe_key: string | null;
  due_at: string;
  not_after: string | null;
  status: DueJobStatus;
  payload: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  result: string | null;
  user_id: string | null;
  connected_account_id: string | null;
  created_at: string;
  updated_at: string;
};

function rowToRecord(row: RawDueJobRow): DueJobRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  let result: unknown;
  if (row.result) {
    try {
      result = JSON.parse(row.result);
    } catch {
      result = undefined;
    }
  }
  return {
    id: row.id,
    jobType: row.job_type,
    dedupeKey: row.dedupe_key ?? undefined,
    dueAt: row.due_at,
    notAfter: row.not_after ?? undefined,
    status: row.status,
    payload,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    result,
    userId: row.user_id ?? undefined,
    connectedAccountId: row.connected_account_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Idempotent enqueue ONLY when a `dedupeKey` is provided: INSERT OR IGNORE on (job_type,
 * dedupe_key), and SQLite's UNIQUE constraint treats every NULL as distinct from every other NULL —
 * so calling this repeatedly with no `dedupeKey` inserts a new row every time, not one deduped row.
 * Returns true only when a new row was actually inserted (false when the dedupe key already
 * existed — not an error, the caller asked for a job that's already scheduled/claimed/done).
 */
export function enqueueDueJob(input: {
  id?: string;
  jobType: string;
  dedupeKey?: string;
  dueAt: string;
  notAfter?: string;
  payload?: Record<string, unknown>;
  userId?: string;
  connectedAccountId?: string;
  now?: string;
}): boolean {
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? crypto.randomUUID();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO due_jobs (
        id, job_type, dedupe_key, due_at, not_after, status, payload,
        attempts, user_id, connected_account_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.jobType,
      input.dedupeKey ?? null,
      input.dueAt,
      input.notAfter ?? null,
      JSON.stringify(input.payload ?? {}),
      input.userId ?? null,
      input.connectedAccountId ?? null,
      now,
      now
    );
  return result.changes > 0;
}

/**
 * Atomically claim up to `limit` due jobs of `jobType`: pending jobs whose due_at has passed, PLUS
 * previously-claimed jobs whose lease has expired (stale reclaim — the gap mobile_commands has).
 * Each candidate row is claimed with a conditional UPDATE that re-checks the same predicate; a lost
 * race (another process/tick claimed it first) yields changes !== 1 and the row is skipped rather
 * than double-claimed. Bumps `attempts` on claim (not on enqueue) so attempts counts claim/execute
 * cycles, matching the retry-backoff semantics in failDueJob.
 */
export function claimDueJobs(
  jobType: string,
  options: { limit?: number; leaseMs?: number; claimant: string; now?: Date }
): DueJobRecord[] {
  const database = getDb();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseMs = options.leaseMs ?? 5 * 60_000;
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

  const claim = database.transaction((): DueJobRecord[] => {
    const candidates = database
      .prepare(
        `SELECT id FROM due_jobs
         WHERE job_type = ?
           AND due_at <= ?
           AND (
             status = 'pending'
             OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
           )
         ORDER BY due_at ASC
         LIMIT ?`
      )
      .all(jobType, nowIso, nowIso, limit) as Array<{ id: string }>;

    const claimed: DueJobRecord[] = [];
    const claimStmt = database.prepare(
      `UPDATE due_jobs
       SET status = 'claimed', claimed_by = ?, claimed_at = ?, lease_expires_at = ?,
           attempts = attempts + 1, updated_at = ?
       WHERE id = ?
         AND (
           status = 'pending'
           OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
         )`
    );
    const readStmt = database.prepare("SELECT * FROM due_jobs WHERE id = ?");

    for (const candidate of candidates) {
      const info = claimStmt.run(options.claimant, nowIso, leaseExpiresAt, nowIso, candidate.id, nowIso);
      if (info.changes !== 1) continue; // lost the race — another claimant got it first
      const row = readStmt.get(candidate.id) as RawDueJobRow | undefined;
      if (row) claimed.push(rowToRecord(row));
    }
    return claimed;
  });

  try {
    return claim.immediate() as DueJobRecord[];
  } catch {
    // Fail closed: an unexpected error during claim means we can't prove ownership of anything.
    return [];
  }
}

/**
 * Mark a claimed job done, storing an optional JSON-serializable result. Fenced to the claimant: the
 * UPDATE only applies `WHERE status = 'claimed' AND claimed_by = ?claimant`, so a worker whose lease
 * already expired (and whose job was reclaimed by a different worker, or completed/failed by it)
 * cannot resurrect/overwrite a job it no longer owns. Returns true only when this call's row actually
 * transitioned — false means the fence held and the caller should treat its own completion as moot.
 */
export function completeDueJob(id: string, claimant: string, result?: unknown, now: string = new Date().toISOString()): boolean {
  const info = getDb()
    .prepare("UPDATE due_jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?")
    .run(result === undefined ? null : JSON.stringify(result), now, id, claimant);
  return info.changes === 1;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_MS = 10 * 60_000;

/**
 * Mark a claimed job failed. Retries with pushed-out due_at (back to 'pending') unless the job
 * has exhausted its attempt budget OR is already past its `not_after` deadline — either of which
 * makes it terminally 'unresolvable' (kill-survivorship: never left pending forever).
 *
 * Fenced to the claimant: both the retry-to-pending and the terminal-unresolvable UPDATE require
 * `status = 'claimed' AND claimed_by = ?claimant`, so a lease-expired worker calling this after
 * another worker already reclaimed (or completed/failed) the row is a silent no-op rather than a
 * resurrection of a job it no longer owns.
 */
export function failDueJob(
  id: string,
  claimant: string,
  error: string,
  options: { maxAttempts?: number; retryBackoffMs?: number; now?: Date } = {}
): DueJobStatus {
  const database = getDb();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  const row = database.prepare("SELECT * FROM due_jobs WHERE id = ?").get(id) as RawDueJobRow | undefined;
  // Unknown id: nothing to transition. There is no 'failed' status to fall back to (see the
  // DueJobStatus note above) — report the nearest honest terminal state instead of inventing one.
  if (!row) return "unresolvable";

  const pastDeadline = row.not_after ? row.not_after < nowIso : false;
  const exhausted = row.attempts >= maxAttempts;

  if (pastDeadline || exhausted) {
    const info = database
      .prepare(
        "UPDATE due_jobs SET status = 'unresolvable', last_error = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?"
      )
      .run(error, nowIso, id, claimant);
    return info.changes === 1 ? "unresolvable" : row.status;
  }

  const nextDueAt = new Date(now.getTime() + retryBackoffMs).toISOString();
  const info = database
    .prepare(
      "UPDATE due_jobs SET status = 'pending', due_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?"
    )
    .run(nextDueAt, error, nowIso, id, claimant);
  return info.changes === 1 ? "pending" : row.status;
}

/** Directly mark a job terminally unresolvable (e.g. the worker decides upfront a job can never
 * be completed — no live-quote source, window already closed at claim time). Fenced to the
 * claimant: only transitions a row this claimant currently holds a live claim on. Returns true only
 * when this call's row actually transitioned. */
export function markDueJobUnresolvable(id: string, claimant: string, reason: string, now: string = new Date().toISOString()): boolean {
  const info = getDb()
    .prepare("UPDATE due_jobs SET status = 'unresolvable', last_error = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?")
    .run(reason, now, id, claimant);
  return info.changes === 1;
}

export interface DueJobStats {
  pending: number;
  claimed: number;
  done: number;
  unresolvable: number;
}

/** Small per-job-type receipt: counts by status. Never throws — returns all-zero on error. */
export function getDueJobStats(jobType?: string): DueJobStats {
  const stats: DueJobStats = { pending: 0, claimed: 0, done: 0, unresolvable: 0 };
  try {
    const rows = jobType
      ? (getDb()
          .prepare("SELECT status, COUNT(*) AS n FROM due_jobs WHERE job_type = ? GROUP BY status")
          .all(jobType) as Array<{ status: DueJobStatus; n: number }>)
      : (getDb().prepare("SELECT status, COUNT(*) AS n FROM due_jobs GROUP BY status").all() as Array<{
          status: DueJobStatus;
          n: number;
        }>);
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = row.n;
    }
  } catch {
    // best-effort — receipts must never throw
  }
  return stats;
}

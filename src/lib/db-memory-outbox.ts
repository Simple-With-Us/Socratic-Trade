// db-memory-outbox.ts — durable retry outbox for fail-open memory writes (ST-4678).
//
// The episodic/learning memory writers (experience-memory.ts closed-lot experiences, db-socratic.ts
// decision re-index, chat/coach-learning.ts coach-URL lesson vectors) are fire-and-forget and must
// never affect the money path: on a vector-store failure they warn and drop the write. That lost
// learning permanently. This outbox gives those writes a durable retry: the catch site enqueues the
// kind + payload here, and a bounded drain (called from the periodic outcome-engine pass) replays
// each entry through the EXISTING writer for its kind, deleting on success and backing off on
// failure until a small attempt cap drops it with one warning.
//
// Schema lives in db.ts migrate() (versioned migration 105). Advisory durability only: the outbox
// never gates, blocks, or fails a fill recording, decision write, or chat reply. Both enqueue and
// drain are fail-safe — neither can throw into its caller.
import "server-only";
import { randomUUID } from "crypto";
import { getDb } from "./db";

/** The fail-open memory writers that enqueue here. Each maps to an existing writer in the drain. */
export type MemoryWriteKind = "closed-lot-experience" | "socratic-decision-reindex" | "coach-url-lesson";

export interface MemoryWriteOutboxRow {
  id: string;
  userId: string;
  kind: string;
  payload: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
}

/** Small attempt cap: after this many failed replays the entry is dropped with one warning. */
export const MEMORY_WRITE_MAX_ATTEMPTS = 5;
/** Exponential backoff base / ceiling (ms). First retry ~1 min, doubling, capped at 1 h. */
export const MEMORY_WRITE_BACKOFF_BASE_MS = 60_000;
export const MEMORY_WRITE_BACKOFF_MAX_MS = 3_600_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Backoff delay before the NEXT attempt, given the attempt count just recorded (1-based). */
export function memoryWriteBackoffMs(attempts: number): number {
  const exp = MEMORY_WRITE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, MEMORY_WRITE_BACKOFF_MAX_MS);
}

/**
 * Enqueue a failed memory write for durable retry. FAIL-SAFE: a DB error here is warned and
 * swallowed so the calling fail-open writer keeps its never-throw contract. `payload` is the
 * JSON-serializable input the drain replays through the existing writer for `kind`.
 */
export function enqueueMemoryWrite(
  kind: MemoryWriteKind,
  payload: unknown,
  userId: string,
  err?: unknown
): void {
  try {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO memory_write_outbox (id, user_id, kind, payload, attempts, last_error, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(randomUUID(), userId, kind, JSON.stringify(payload ?? null), err ? errorMessage(err) : null, now, now);
  } catch (enqueueErr) {
    console.warn(
      "[memory-outbox] failed to enqueue retry (write dropped):",
      errorMessage(enqueueErr)
    );
  }
}

/** Due entries (next_attempt_at <= now), oldest first, bounded by `limit`. */
export function listDueMemoryWrites(limit: number = 20, now: number = Date.now()): MemoryWriteOutboxRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, kind, payload, attempts, last_error, next_attempt_at, created_at
       FROM memory_write_outbox WHERE next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, created_at ASC LIMIT ?`
    )
    .all(new Date(now).toISOString(), Math.max(1, limit)) as Array<{
    id: string;
    user_id: string;
    kind: string;
    payload: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    payload: row.payload,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at
  }));
}

function deleteMemoryWrite(id: string): void {
  getDb().prepare("DELETE FROM memory_write_outbox WHERE id = ?").run(id);
}

function recordMemoryWriteFailure(id: string, attempts: number, lastError: string, nextAttemptAt: string): void {
  getDb()
    .prepare("UPDATE memory_write_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
    .run(attempts, lastError, nextAttemptAt, id);
}

/**
 * Replay one entry through the EXISTING writer for its kind. Throws on a genuine write failure (the
 * drain counts that toward the attempt cap); a legitimate no-op (e.g. the decision was deleted) is a
 * success. Dynamic imports keep this module free of static cycles with the writer modules. No LLM
 * calls — every writer here is a vector/SQLite re-index.
 */
async function replayMemoryWrite(kind: string, payload: unknown): Promise<void> {
  switch (kind) {
    case "closed-lot-experience": {
      const { recordClosedLotExperienceCore } = await import("./experience-memory");
      await recordClosedLotExperienceCore(payload as Parameters<typeof recordClosedLotExperienceCore>[0]);
      return;
    }
    case "socratic-decision-reindex": {
      const { getSocraticDecisionCase } = await import("./db-socratic");
      const { indexSocraticDecisionMemory } = await import("./socratic-memory");
      const target = payload as { decisionId?: string; userId?: string };
      if (!target?.decisionId) return; // nothing to re-index
      const decision = getSocraticDecisionCase(target.decisionId, target.userId ?? "local");
      if (!decision) return; // decision gone (e.g. account deleted) — nothing to index
      await indexSocraticDecisionMemory(decision);
      return;
    }
    case "coach-url-lesson": {
      const { indexStandaloneLesson } = await import("./chat/coach-learning");
      await indexStandaloneLesson(payload as Parameters<typeof indexStandaloneLesson>[0]);
      return;
    }
    default:
      throw new Error(`unknown memory write kind: ${kind}`);
  }
}

export interface MemoryWriteDrainResult {
  replayed: number;
  succeeded: number;
  failed: number;
  dropped: number;
}

/**
 * Bounded drain: replay up to `limit` due entries through their existing writers. Deletes on success,
 * increments attempts with exponential backoff on failure, and drops an entry after
 * MEMORY_WRITE_MAX_ATTEMPTS with one warning. NEVER throws into its caller — every per-row replay and
 * every DB op is guarded, so the periodic outcome pass can call it unconditionally.
 */
export async function drainMemoryWriteOutbox(limit: number = 20): Promise<MemoryWriteDrainResult> {
  const result: MemoryWriteDrainResult = { replayed: 0, succeeded: 0, failed: 0, dropped: 0 };
  let due: MemoryWriteOutboxRow[];
  try {
    due = listDueMemoryWrites(limit);
  } catch (err) {
    console.warn("[memory-outbox] drain could not list due writes:", errorMessage(err));
    return result;
  }
  for (const row of due) {
    result.replayed += 1;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
    try {
      await replayMemoryWrite(row.kind, payload);
      try {
        deleteMemoryWrite(row.id);
        result.succeeded += 1;
      } catch (err) {
        console.warn("[memory-outbox] replay succeeded but delete failed:", errorMessage(err));
      }
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = errorMessage(err);
      if (attempts >= MEMORY_WRITE_MAX_ATTEMPTS) {
        console.warn(
          `[memory-outbox] dropping ${row.kind} write ${row.id} after ${attempts} attempts: ${message}`
        );
        try {
          deleteMemoryWrite(row.id);
          result.dropped += 1;
        } catch (deleteErr) {
          console.warn("[memory-outbox] failed to drop exhausted write:", errorMessage(deleteErr));
        }
      } else {
        const nextAttemptAt = new Date(Date.now() + memoryWriteBackoffMs(attempts)).toISOString();
        try {
          recordMemoryWriteFailure(row.id, attempts, message, nextAttemptAt);
          result.failed += 1;
        } catch (updateErr) {
          console.warn("[memory-outbox] failed to record retry backoff:", errorMessage(updateErr));
        }
      }
    }
  }
  return result;
}
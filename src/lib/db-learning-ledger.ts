// db-learning-ledger.ts — CRUD for the unified learning-mutation ledger (panel P0-4).
//
// The `learning_mutations` table (see db.ts migrate()) is the single append-only record of EVERY
// autonomous learning mutation: factor-weight applies today, and any future auto-tuning. Recording is
// PASSIVE/always-on — it only writes an audit trail and changes no trading behavior. The higher-level
// `learning-ledger.ts` wraps these primitives with the setPolicy-based capture/revert semantics; this
// module is intentionally thin (persistence only, module-per-concern).

import "server-only";
import { getDb } from "./db";

/** A recorded learning mutation. `beforeState`/`afterState`/`evidence` are already JSON-parsed. */
export interface LearningMutationRow {
  id: string;
  userId: string;
  connectedAccountId?: string;
  subsystem: string;
  trigger?: string;
  runId?: string;
  flag?: string;
  beforeState: unknown;
  afterState: unknown;
  evidence?: unknown;
  revertedAt?: string;
  revertedBy?: string;
  createdAt: string;
}

export interface InsertLearningMutationInput {
  userId?: string;
  connectedAccountId?: string;
  subsystem: string;
  trigger?: string;
  runId?: string;
  flag?: string;
  beforeState: unknown;
  afterState: unknown;
  evidence?: unknown;
}

type RawRow = {
  id: string;
  user_id: string;
  connected_account_id: string | null;
  subsystem: string;
  trigger: string | null;
  run_id: string | null;
  flag: string | null;
  before_state: string;
  after_state: string;
  evidence: string | null;
  reverted_at: string | null;
  reverted_by: string | null;
  created_at: string;
};

function mapRow(row: RawRow): LearningMutationRow {
  return {
    id: row.id,
    userId: row.user_id,
    connectedAccountId: row.connected_account_id ?? undefined,
    subsystem: row.subsystem,
    trigger: row.trigger ?? undefined,
    runId: row.run_id ?? undefined,
    flag: row.flag ?? undefined,
    beforeState: JSON.parse(row.before_state),
    afterState: JSON.parse(row.after_state),
    evidence: row.evidence == null ? undefined : JSON.parse(row.evidence),
    revertedAt: row.reverted_at ?? undefined,
    revertedBy: row.reverted_by ?? undefined,
    createdAt: row.created_at
  };
}

/** Append one learning-mutation ledger row. Returns the row id. Passive/always-on. */
export function insertLearningMutation(input: InsertLearningMutationInput): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO learning_mutations
        (id, user_id, connected_account_id, subsystem, trigger, run_id, flag, before_state, after_state, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.userId ?? "local",
      input.connectedAccountId ?? "",
      input.subsystem,
      input.trigger ?? null,
      input.runId ?? null,
      input.flag ?? null,
      JSON.stringify(input.beforeState),
      JSON.stringify(input.afterState),
      input.evidence === undefined ? null : JSON.stringify(input.evidence),
      new Date().toISOString()
    );
  return id;
}

/**
 * Most-recent NON-REVERTED ledger row for a (user, account, subsystem). Scoping by subsystem keeps a
 * revert from crossing subsystems; scoping by account keeps it from crossing accounts. Returns undefined
 * when nothing revertible exists.
 */
export function latestLearningMutation(
  subsystem: string,
  userId: string = "local",
  connectedAccountId?: string
): LearningMutationRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM learning_mutations
       WHERE user_id = ? AND connected_account_id = ? AND subsystem = ? AND reverted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId, connectedAccountId ?? "", subsystem) as RawRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** A page of ledger rows for a (user, account), newest first. `subsystem` narrows to one subsystem. */
export function listLearningMutations(
  userId: string = "local",
  options: { connectedAccountId?: string; subsystem?: string; limit?: number } = {}
): LearningMutationRow[] {
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const params: unknown[] = [userId, options.connectedAccountId ?? ""];
  let sql =
    "SELECT * FROM learning_mutations WHERE user_id = ? AND connected_account_id = ?";
  if (options.subsystem) {
    sql += " AND subsystem = ?";
    params.push(options.subsystem);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params) as RawRow[];
  return rows.map(mapRow);
}

/**
 * All of a user's ledger rows created at/after `sinceIso`, ACROSS connected accounts (unlike
 * listLearningMutations, whose default `connected_account_id = ''` filter returns only user-wide
 * rows). Used by the daily learning review's context pack: "what did the system auto-tune recently".
 */
export function listLearningMutationsSince(
  userId: string,
  sinceIso: string,
  limit = 100
): LearningMutationRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM learning_mutations WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, sinceIso, Math.max(1, Math.min(500, limit))) as RawRow[];
  return rows.map(mapRow);
}

/** Fetch a single ledger row by id (scoped to the owning user to avoid cross-user reads). */
export function getLearningMutationById(id: string, userId: string = "local"): LearningMutationRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM learning_mutations WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** Mark a ledger row reverted (idempotent: only stamps a row that isn't already reverted). */
export function markLearningMutationReverted(id: string, userId: string = "local", revertedBy?: string): void {
  getDb()
    .prepare(
      "UPDATE learning_mutations SET reverted_at = ?, reverted_by = ? WHERE id = ? AND user_id = ? AND reverted_at IS NULL"
    )
    .run(new Date().toISOString(), revertedBy ?? null, id, userId);
}

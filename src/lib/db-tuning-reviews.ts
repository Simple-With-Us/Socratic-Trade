// db-tuning-reviews.ts — CRUD for persisted strategy-tuning reviews (survive disconnect).
//
// A POST /api/strategy/tune review (the paid LLM proposeStrategyTuning output) used to live only in
// client React state — closing the browser (or losing the connection) before Apply silently lost
// the review. This module persists each review server-side so it can be re-fetched after a
// reload/disconnect. See app/api/strategy/tune/route.ts and db.ts migrate() for the table DDL.

import "server-only";
import crypto from "crypto";
import { getDb } from "./db";

export type StrategyTuningReviewStatus = "open" | "applied" | "dismissed";

export interface StrategyTuningReviewRow {
  id: string;
  userId: string;
  connectedAccountId?: string;
  model?: string;
  reasoningEffort?: string;
  generatedBy: string;
  /** The full persisted review payload (the JSON response returned to the client), already parsed. */
  result: unknown;
  status: StrategyTuningReviewStatus;
  createdAt: string;
  resolvedAt?: string;
}

type RawRow = {
  id: string;
  user_id: string;
  connected_account_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  generated_by: string;
  result: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
};

function mapRow(row: RawRow): StrategyTuningReviewRow {
  return {
    id: row.id,
    userId: row.user_id,
    connectedAccountId: row.connected_account_id ?? undefined,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    generatedBy: row.generated_by,
    result: JSON.parse(row.result),
    status: row.status as StrategyTuningReviewStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined
  };
}

export interface InsertStrategyTuningReviewInput {
  userId: string;
  connectedAccountId?: string;
  model?: string;
  reasoningEffort?: string;
  generatedBy: string;
  result: unknown;
}

/**
 * Persist a new strategy-tuning review. A newer review supersedes any still-'open' prior review for
 * the SAME (user, connected account) — auto-dismissed atomically in the same transaction, so at most
 * one review stays 'open' per (user, account) at a time. `connectedAccountId` absent means the
 * user-wide (no-account) slot; it is compared with `IS` so it only ever matches other user-wide rows,
 * never a specific account's row. Returns the new review's id.
 */
export function insertStrategyTuningReview(input: InsertStrategyTuningReviewInput): string {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const connectedAccountId = input.connectedAccountId ?? null;
  db.transaction(() => {
    db.prepare(
      `UPDATE strategy_tuning_reviews SET status = 'dismissed', resolved_at = ?
       WHERE user_id = ? AND status = 'open' AND connected_account_id IS ?`
    ).run(now, input.userId, connectedAccountId);
    db.prepare(
      `INSERT INTO strategy_tuning_reviews
        (id, user_id, connected_account_id, model, reasoning_effort, generated_by, result, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).run(
      id,
      input.userId,
      connectedAccountId,
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.generatedBy,
      JSON.stringify(input.result),
      now
    );
  })();
  return id;
}

/**
 * Most recent 'open' review for a (user, connected account). `connectedAccountId` uses `IS` matching:
 * omitted/undefined matches ONLY rows whose connected_account_id is NULL — never a different
 * account's open review.
 */
export function getLatestOpenStrategyTuningReview(
  userId: string,
  connectedAccountId?: string
): StrategyTuningReviewRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM strategy_tuning_reviews
       WHERE user_id = ? AND status = 'open' AND connected_account_id IS ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(userId, connectedAccountId ?? null) as RawRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** A page of a user's reviews (any status), newest first, optionally narrowed to one connected account. */
export function listStrategyTuningReviews(
  userId: string,
  opts: { connectedAccountId?: string; limit?: number } = {}
): StrategyTuningReviewRow[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));
  const clauses = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM strategy_tuning_reviews WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args) as RawRow[];
  return rows.map(mapRow);
}

/**
 * Mark a review 'applied' or 'dismissed', stamping resolved_at. Ownership-checked via the WHERE
 * clause (user_id = userId) — one user can never resolve another user's review. Returns whether a
 * row actually matched (false => not found or not owned by this user; the route 404s on false).
 */
export function setStrategyTuningReviewStatus(
  id: string,
  userId: string,
  status: Extract<StrategyTuningReviewStatus, "applied" | "dismissed">
): boolean {
  const result = getDb()
    // Only an 'open' review may transition: a stale or duplicate PATCH must not flip an
    // already-applied review to dismissed (or vice versa). Resolved rows are immutable.
    .prepare("UPDATE strategy_tuning_reviews SET status = ?, resolved_at = ? WHERE id = ? AND user_id = ? AND status = 'open'")
    .run(status, new Date().toISOString(), id, userId);
  return result.changes > 0;
}

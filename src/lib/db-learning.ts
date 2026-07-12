// db-learning.ts — audit-event helpers, counterfactual learning watermarks/candidates,
// learned-context fact-tier functions, and RAG ingestion (ingested_accessions).
import { getDb } from "./db";
import { mergeHorizonRows } from "./outcome-horizons";
import type { LearnedContextRow, LearnedContextPendingRow, LearnedContextPendingStatus, SocraticOutcomeHorizonRow } from "./types";

// ── Audit-event helpers ────────────────────────────────────────────────────────

export function listAudit(
  limit = 100,
  userId: string = "local",
  connectedAccountId?: string,
  includeUserWide = false
): Array<{ id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string }> {
  const rows = (connectedAccountId
    ? getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE user_id = ? AND (connected_account_id = ?${includeUserWide ? " OR connected_account_id IS NULL" : ""})
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, connectedAccountId, limit)
    : getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit)) as Array<{ id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  }));
}

export function latestAuditByKind(
  kind: string,
  userId: string = "local",
  connectedAccountId?: string
): { id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string } | undefined {
  const row = (connectedAccountId
    ? getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? AND connected_account_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId, connectedAccountId)
    : getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId)) as { id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  };
}

/**
 * Recent audit events of ONE kind, newest first. Unlike `listAudit` (all kinds, then the
 * caller filters), the LIMIT applies AFTER the kind filter — so a flood of newer audit rows
 * of other kinds can never push the requested kind's history out of the window (Codex review
 * on PR #365: `getRedTeamEfficacy` scanned the all-kind feed and could report zero/partial
 * veto history in busy accounts). When `connectedAccountId` is given, user-wide rows
 * (connected_account_id IS NULL) are included too: veto audits were historically written
 * user-wide, so an account-scoped query must not silently drop that legacy history.
 */
export function listAuditByKind(
  kind: string,
  limit = 100,
  userId: string = "local",
  connectedAccountId?: string
): Array<{ id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string }> {
  const rows = (connectedAccountId
    ? getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE kind = ? AND user_id = ? AND (connected_account_id = ? OR connected_account_id IS NULL)
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(kind, userId, connectedAccountId, limit)
    : getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE kind = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(kind, userId, limit)) as Array<{ id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  }));
}

export interface SignalSnapshotAuditRow {
  rowid: number;
  id: string;
  createdAt: string;
  payload: unknown;
}

export function listSignalSnapshotAuditAfter(
  userId: string = "local",
  watermark?: { lastAuditRowid?: number },
  limit = 100,
  connectedAccountId?: string
): SignalSnapshotAuditRow[] {
  const hasWatermark = typeof watermark?.lastAuditRowid === "number";
  // Per-account scoping: when an account id is given, only that account's snapshots count toward
  // its learning. rowid is globally monotonic, so `rowid > lastAuditRowid AND account = ?` advances
  // each account's watermark over its own rows independently.
  const accountClause = connectedAccountId ? " AND connected_account_id = ?" : "";
  const rows = hasWatermark
    ? (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ?
            AND kind = 'signal_snapshot'
            AND rowid > ?${accountClause}
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(...(connectedAccountId
          ? [userId, watermark!.lastAuditRowid, connectedAccountId, limit]
          : [userId, watermark!.lastAuditRowid, limit])) as Array<{ rowid: number; id: string; created_at: string; payload: string }>)
    : (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ? AND kind = 'signal_snapshot'${accountClause}
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(...(connectedAccountId ? [userId, connectedAccountId, limit] : [userId, limit])) as Array<{ rowid: number; id: string; created_at: string; payload: string }>);

  return rows.map((row) => ({ rowid: row.rowid, id: row.id, createdAt: row.created_at, payload: JSON.parse(row.payload) }));
}

// ── Counterfactual learning watermarks ────────────────────────────────────────

export interface CounterfactualLearningWatermark {
  userId: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt: string;
}

// Per-account watermarks: the table's PK is (user_id, connected_account_id). The account-agnostic
// (user-wide) watermark is stored with connected_account_id = '' (empty string, never NULL) so the
// composite PK stays well-defined — SQLite would treat multiple NULLs as distinct, breaking upserts.
export function getCounterfactualLearningWatermark(
  userId: string = "local",
  connectedAccountId?: string
): CounterfactualLearningWatermark | undefined {
  const row = getDb()
    .prepare("SELECT user_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at FROM counterfactual_learning_watermarks WHERE user_id = ? AND connected_account_id = ?")
    .get(userId, connectedAccountId ?? "") as { user_id: string; last_audit_rowid: number | null; last_audit_created_at: string | null; last_audit_id: string | null; updated_at: string } | undefined;
  if (!row) return undefined;
  return {
    userId: row.user_id,
    lastAuditRowid: row.last_audit_rowid ?? undefined,
    lastAuditCreatedAt: row.last_audit_created_at ?? undefined,
    lastAuditId: row.last_audit_id ?? undefined,
    updatedAt: row.updated_at
  };
}

export function setCounterfactualLearningWatermark(input: {
  userId?: string;
  connectedAccountId?: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt?: string;
}): void {
  const userId = input.userId ?? "local";
  const connectedAccountId = input.connectedAccountId ?? "";
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO counterfactual_learning_watermarks (user_id, connected_account_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connected_account_id) DO UPDATE SET
        last_audit_rowid = excluded.last_audit_rowid,
        last_audit_created_at = excluded.last_audit_created_at,
        last_audit_id = excluded.last_audit_id,
        updated_at = excluded.updated_at`
    )
    .run(userId, connectedAccountId, input.lastAuditRowid ?? null, input.lastAuditCreatedAt ?? null, input.lastAuditId ?? null, updatedAt);
}

// ── Skipped-candidate counterfactuals ─────────────────────────────────────────

export interface SkippedCounterfactualCandidateInput {
  userId?: string;
  connectedAccountId?: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  now?: string;
}

export interface SkippedCounterfactualRow {
  id: string;
  userId: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  status: "pending" | "matured" | "unresolvable";
  exitDate?: string;
  exitPrice?: number;
  returnPct?: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  /** Multi-horizon outcome rows (15m/1h/1d/1w) written at maturation; each row is individually
   * 'ok' or honestly 'unresolvable'. Absent on rows matured before the multi-horizon schema. */
  outcomes?: SocraticOutcomeHorizonRow[];
  /** Terminal reason when status === 'unresolvable' (e.g. "no_price_series",
   * "no_bar_at_or_after_target" — delisted/renamed symbols land here after the bounded recheck window). */
  resolutionReason?: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

type RawSkippedCounterfactualRow = {
  id: string;
  user_id: string;
  run_id: string;
  symbol: string;
  snapshot_at: string;
  ref_price: number;
  horizon_days: number;
  target_date: string;
  status: string;
  exit_date: string | null;
  exit_price: number | null;
  return_pct: number | null;
  score: number | null;
  sector: string | null;
  regime: string | null;
  dominant_factor: string | null;
  bulletins: string | null;
  outcomes: string | null;
  resolution_reason: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toSkippedCounterfactualRow(row: RawSkippedCounterfactualRow): SkippedCounterfactualRow {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    symbol: row.symbol,
    snapshotAt: row.snapshot_at,
    refPrice: row.ref_price,
    horizonDays: row.horizon_days,
    targetDate: row.target_date,
    status: row.status === "matured" ? "matured" : row.status === "unresolvable" ? "unresolvable" : "pending",
    exitDate: row.exit_date ?? undefined,
    exitPrice: row.exit_price ?? undefined,
    returnPct: row.return_pct ?? undefined,
    score: row.score ?? undefined,
    sector: row.sector ?? undefined,
    regime: row.regime ?? undefined,
    dominantFactor: row.dominant_factor ?? undefined,
    bulletins: row.bulletins ? JSON.parse(row.bulletins) as string[] : undefined,
    outcomes: row.outcomes ? JSON.parse(row.outcomes) as SocraticOutcomeHorizonRow[] : undefined,
    resolutionReason: row.resolution_reason ?? undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Deterministic skipped-candidate-counterfactual row id — single-sourced here so callers that need
 * to reference the row before/without re-reading it (e.g. enqueueing its intraday sample due-jobs
 * right after insert) can derive the same id rather than duplicating the format. */
export function skippedCounterfactualId(userId: string, runId: string, symbol: string, horizonDays: number): string {
  return `${userId}:${runId}:${symbol}:${horizonDays}`;
}

export function insertSkippedCounterfactualCandidate(input: SkippedCounterfactualCandidateInput): boolean {
  const userId = input.userId ?? "local";
  const now = input.now ?? new Date().toISOString();
  const id = skippedCounterfactualId(userId, input.runId, input.symbol, input.horizonDays);
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM skipped_candidate_counterfactuals WHERE id = ? AND user_id = ?")
    .get(id, userId);
  if (existing) {
    // A row for this (runId, symbol, horizon) already exists — e.g. a Bear-veto/policy-block
    // early insert that carried only `regime`, later followed by the run's richer
    // signal_snapshot ingestion carrying score/sector/dominant-factor/bulletin evidence
    // (Codex review on PR #365: pure INSERT OR IGNORE let the early bare insert permanently
    // strip the matured row of the evidence metadata missed-opportunity analytics/tuning read).
    // Backfill ONLY evidence columns that are still NULL: the first write stays authoritative
    // for pricing/snapshot/status (never re-priced), existing evidence is never overwritten,
    // and updated_at is left alone so metadata backfill can't reorder maturation listings.
    if (
      input.score !== undefined ||
      input.sector !== undefined ||
      input.regime !== undefined ||
      input.dominantFactor !== undefined ||
      (input.bulletins && input.bulletins.length > 0)
    ) {
      db.prepare(
        `UPDATE skipped_candidate_counterfactuals SET
          score = COALESCE(score, ?),
          sector = COALESCE(sector, ?),
          regime = COALESCE(regime, ?),
          dominant_factor = COALESCE(dominant_factor, ?),
          bulletins = COALESCE(bulletins, ?)
         WHERE id = ? AND user_id = ?`
      ).run(
        input.score ?? null,
        input.sector ?? null,
        input.regime ?? null,
        input.dominantFactor ?? null,
        input.bulletins && input.bulletins.length > 0 ? JSON.stringify(input.bulletins) : null,
        id,
        userId
      );
    }
    return false;
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO skipped_candidate_counterfactuals (
        id, user_id, connected_account_id, run_id, symbol, snapshot_at, ref_price, horizon_days,
        target_date, status, score, sector, regime, dominant_factor, bulletins,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.connectedAccountId ?? null,
      input.runId,
      input.symbol,
      input.snapshotAt,
      input.refPrice,
      input.horizonDays,
      input.targetDate,
      input.score ?? null,
      input.sector ?? null,
      input.regime ?? null,
      input.dominantFactor ?? null,
      input.bulletins ? JSON.stringify(input.bulletins) : null,
      now,
      now
    );
  return result.changes > 0;
}

export function listPendingSkippedCounterfactuals(input: {
  userId?: string;
  nowDate: string;
  checkedBefore?: string;
  limit?: number;
}): SkippedCounterfactualRow[] {
  const userId = input.userId ?? "local";
  const limit = input.limit ?? 50;
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ?
        AND status = 'pending'
        AND target_date <= ?
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
       ORDER BY target_date ASC, snapshot_at ASC, symbol ASC
       LIMIT ?`
    )
    .all(userId, input.nowDate, input.checkedBefore ?? new Date(0).toISOString(), limit) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

export function markSkippedCounterfactualChecked(id: string, userId: string = "local", checkedAt: string = new Date().toISOString()): void {
  getDb()
    .prepare("UPDATE skipped_candidate_counterfactuals SET last_checked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(checkedAt, checkedAt, id, userId);
}

/** Fresh (uncached) read of just the persisted `outcomes` column for one counterfactual row — used
 * immediately before a terminal write to re-merge against whatever a concurrent worker may have
 * already written (see the lost-update guard note on markSkippedCounterfactualMatured). */
function readPersistedCounterfactualOutcomes(id: string, userId: string): SocraticOutcomeHorizonRow[] | undefined {
  const row = getDb()
    .prepare("SELECT outcomes FROM skipped_candidate_counterfactuals WHERE id = ? AND user_id = ?")
    .get(id, userId) as { outcomes: string | null } | undefined;
  if (!row?.outcomes) return undefined;
  try {
    return JSON.parse(row.outcomes) as SocraticOutcomeHorizonRow[];
  } catch {
    return undefined;
  }
}

/**
 * Lost-update guard: `input.outcomes` may have been built from a pass-start snapshot held across
 * awaits (materializeSkippedCandidateCounterfactuals / outcome-engine's counterfactual worker path),
 * so a worker-sampled 15m/1h row written concurrently could otherwise be erased by this stale write.
 * Re-merge against the FRESH persisted row right before persisting — mergeHorizonRows'
 * existing-terminal-wins semantics make this idempotent/first-writer-wins regardless of write order.
 */
export function markSkippedCounterfactualMatured(input: {
  id: string;
  userId?: string;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  /** Multi-horizon outcome rows (15m/1h/1d/1w) measured alongside the headline horizon return. */
  outcomes?: SocraticOutcomeHorizonRow[];
  checkedAt?: string;
}): boolean {
  const userId = input.userId ?? "local";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const mergedOutcomes = mergeHorizonRows(readPersistedCounterfactualOutcomes(input.id, userId), input.outcomes ?? []);
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET status = 'matured',
        exit_date = ?,
        exit_price = ?,
        return_pct = ?,
        outcomes = ?,
        last_checked_at = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(
      input.exitDate,
      input.exitPrice,
      input.returnPct,
      mergedOutcomes.length > 0 ? JSON.stringify(mergedOutcomes) : null,
      checkedAt,
      checkedAt,
      input.id,
      userId
    );
  return result.changes > 0;
}

/**
 * Terminal kill-survivorship transition: a pending counterfactual whose price series never resolved
 * within the bounded recheck window (delisted / renamed / no provider coverage) becomes
 * status='unresolvable' WITH a reason, instead of sitting 'pending' forever and silently dropping
 * out of every matured-outcome denominator. Unresolvable rows keep their optional multi-horizon
 * outcome rows (each marked unresolvable with its own reason) so coverage math can count them.
 *
 * Lost-update guard: same re-merge-at-write-time treatment as markSkippedCounterfactualMatured above
 * — a worker-sampled 15m/1h row must survive this terminal write even if `input.outcomes` is stale.
 */
export function markSkippedCounterfactualUnresolvable(input: {
  id: string;
  userId?: string;
  reason: string;
  outcomes?: SocraticOutcomeHorizonRow[];
  checkedAt?: string;
}): boolean {
  const userId = input.userId ?? "local";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const mergedOutcomes = mergeHorizonRows(readPersistedCounterfactualOutcomes(input.id, userId), input.outcomes ?? []);
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET status = 'unresolvable',
        resolution_reason = ?,
        outcomes = ?,
        last_checked_at = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(input.reason, mergedOutcomes.length > 0 ? JSON.stringify(mergedOutcomes) : null, checkedAt, checkedAt, input.id, userId);
  return result.changes > 0;
}

/** Counterfactual rows by terminal/pending status — used to join unresolvable rows into scorecard
 * denominators (getRedTeamEfficacy, coverage disclosure). */
export function listSkippedCounterfactualsByStatus(
  userId: string = "local",
  status: "pending" | "matured" | "unresolvable",
  limit = 200,
  connectedAccountId?: string
): SkippedCounterfactualRow[] {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT * FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = ? AND connected_account_id = ?
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(userId, status, connectedAccountId, limit)
    : getDb()
        .prepare(
          `SELECT * FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = ?
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(userId, status, limit)) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

/** Status counts for the skipped-counterfactual pipeline. Unresolvable rows count in the total
 * denominator (kill-survivorship): resolvedPct = matured / (matured + unresolvable + due-pending
 * excluded — pending rows whose target date hasn't arrived are NOT "unresolved", just immature). */
export interface SkippedCounterfactualCoverage {
  total: number;
  matured: number;
  pending: number;
  unresolvable: number;
  /** matured / (matured + unresolvable) as a %, 0 when nothing terminal yet. */
  resolvedPct: number;
  /** Human disclosure line, e.g. "12/15 resolved (80%) — 3 unresolvable; may be survivor-biased". */
  disclosure: string;
}

export function getSkippedCounterfactualCoverage(
  userId: string = "local",
  connectedAccountId?: string
): SkippedCounterfactualCoverage {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT status, COUNT(*) AS n FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND connected_account_id = ? GROUP BY status`
        )
        .all(userId, connectedAccountId)
    : getDb()
        .prepare("SELECT status, COUNT(*) AS n FROM skipped_candidate_counterfactuals WHERE user_id = ? GROUP BY status")
        .all(userId)) as Array<{ status: string; n: number }>;
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  const matured = count("matured");
  const pending = count("pending");
  const unresolvable = count("unresolvable");
  const terminal = matured + unresolvable;
  const resolvedPct = terminal > 0 ? Number(((matured / terminal) * 100).toFixed(1)) : 0;
  const disclosure =
    terminal > 0
      ? `${matured}/${terminal} resolved (${resolvedPct}%)${unresolvable > 0 ? ` — ${unresolvable} unresolvable; may be survivor-biased` : ""}${pending > 0 ? `; ${pending} still maturing` : ""}`
      : `0 resolved${pending > 0 ? `; ${pending} still maturing` : ""}`;
  return { total: matured + pending + unresolvable, matured, pending, unresolvable, resolvedPct, disclosure };
}

/**
 * Merge freshly-sampled intraday (15m/1h) horizon rows into a still-'pending' counterfactual's
 * `outcomes` column WITHOUT touching status/exit fields — used by the due-jobs intraday sampler
 * (outcome-engine.ts's drainDueIntradaySampleJobs), which resolves one horizon at a time and is not
 * the pipeline that closes the whole counterfactual (that's markSkippedCounterfactualMatured /
 * markSkippedCounterfactualUnresolvable, both status='pending'-gated same as this). A no-op once the
 * row has already gone terminal (matured/unresolvable) — those rows' outcomes are owned by their own
 * terminal writer, not by a late-arriving intraday sample.
 */
export function updateSkippedCounterfactualOutcomes(
  id: string,
  userId: string,
  outcomes: SocraticOutcomeHorizonRow[],
  updatedAt: string = new Date().toISOString()
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET outcomes = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(JSON.stringify(outcomes), updatedAt, id, userId);
  return result.changes > 0;
}

/** One counterfactual row by its natural join key (runId, symbol) — the outcome engine joins
 * blocked/rejected/vetoed decision cases to their forward returns through this. */
export function getSkippedCounterfactualByRunSymbol(
  userId: string,
  runId: string,
  symbol: string
): SkippedCounterfactualRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND run_id = ? AND symbol = ?
       ORDER BY horizon_days ASC LIMIT 1`
    )
    .get(userId, runId, symbol) as RawSkippedCounterfactualRow | undefined;
  return row ? toSkippedCounterfactualRow(row) : undefined;
}

/** Exact counterfactual row by its full natural key (runId, symbol, horizonDays) — used by the
 * durable due-jobs intraday sampler (outcome-engine.ts's drainDueIntradaySampleJobs), which carries
 * horizonDays explicitly in its job payload rather than guessing via min(horizon_days) the way
 * getSkippedCounterfactualByRunSymbol does. A (runId, symbol) pair can have more than one row across
 * different horizons (e.g. a Bear-veto early insert vs. the run's own signal-snapshot ingestion using
 * a different configured horizonDays) — this disambiguates to the exact owning row instead of always
 * picking the shortest horizon. */
export function getSkippedCounterfactualByRunSymbolHorizon(
  userId: string,
  runId: string,
  symbol: string,
  horizonDays: number
): SkippedCounterfactualRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND run_id = ? AND symbol = ? AND horizon_days = ?
       LIMIT 1`
    )
    .get(userId, runId, symbol, horizonDays) as RawSkippedCounterfactualRow | undefined;
  return row ? toSkippedCounterfactualRow(row) : undefined;
}

export function listMaturedSkippedCounterfactuals(
  userId: string = "local",
  limit = 50,
  connectedAccountId?: string
): SkippedCounterfactualRow[] {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured' AND connected_account_id = ?
           ORDER BY return_pct DESC, updated_at DESC
           LIMIT ?`
        )
        .all(userId, connectedAccountId, limit)
    : getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured'
           ORDER BY return_pct DESC, updated_at DESC
           LIMIT ?`
        )
        .all(userId, limit)) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

/**
 * The MATURED counterfactual row for one (runId, symbol) veto key — the precise join input
 * for the Red Team efficacy scorecard. Unlike joining against `listMaturedSkippedCounterfactuals`
 * (a return_pct-DESC top slice), a keyed lookup can never drop the low/negative-return rows —
 * the exact avoided-loss cases `vetoValueAddRate` exists to count (Codex review on PR #365).
 * Multiple horizons can exist per key; the shortest horizon wins deterministically.
 */
export function getMaturedSkippedCounterfactualByRunSymbol(
  userId: string,
  runId: string,
  symbol: string
): SkippedCounterfactualRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND run_id = ? AND symbol = ? AND status = 'matured'
       ORDER BY horizon_days ASC
       LIMIT 1`
    )
    .get(userId, runId, symbol) as RawSkippedCounterfactualRow | undefined;
  return row ? toSkippedCounterfactualRow(row) : undefined;
}

// ── Learned-context fact-tier CRUD ────────────────────────────────────────────

interface RawLearnedContextRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: string;
  risk_tier: string;
  confidence: number;
  contributor_user_id: string | null;
  asserted_at: string;
  superseded_by: string | null;
  expires_at: string | null;
}

export function mapLearnedContext(row: RawLearnedContextRow): LearnedContextRow {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as LearnedContextRow["scope"],
    kind: row.kind as LearnedContextRow["kind"],
    subject: row.subject,
    symbol: row.symbol,
    value: row.value,
    source: row.source,
    origin: row.origin as LearnedContextRow["origin"],
    riskTier: row.risk_tier as LearnedContextRow["riskTier"],
    confidence: row.confidence,
    contributorUserId: row.contributor_user_id,
    assertedAt: row.asserted_at,
    supersededBy: row.superseded_by,
    expiresAt: row.expires_at
  };
}

export function insertLearnedContext(row: LearnedContextRow): LearnedContextRow {
  getDb()
    .prepare(
      `INSERT INTO learned_context
        (id, user_id, scope, kind, subject, symbol, value, source, origin, risk_tier, confidence, contributor_user_id, asserted_at, superseded_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId,
      row.scope,
      row.kind,
      row.subject,
      row.symbol,
      row.value,
      row.source,
      row.origin,
      row.riskTier,
      row.confidence,
      row.contributorUserId,
      row.assertedAt,
      row.supersededBy,
      row.expiresAt
    );
  return row;
}

export function findLiveLearnedContextBySubject(
  userId: string,
  kind: string,
  subject: string,
  symbol: string | null
): LearnedContextRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM learned_context
       WHERE user_id = ? AND kind = ? AND subject = ? AND ((symbol IS NULL AND ? IS NULL) OR symbol = ?)
         AND superseded_by IS NULL
       ORDER BY asserted_at DESC LIMIT 1`
    )
    .get(userId, kind, subject, symbol, symbol) as RawLearnedContextRow | undefined;
  return row ? mapLearnedContext(row) : null;
}

/**
 * Live FACT rows for a decision: the user's own private rows plus, when includeShared is set,
 * other contributors' opted-in shared rows. Filtered to the given symbols (plus symbol-less
 * rows, which are general facts) and to non-expired rows. READ-ONLY — never mutates.
 */
export function listLearnedContextForDecision(
  userId: string,
  symbols: string[],
  includeShared = false
): LearnedContextRow[] {
  const nowIso = new Date().toISOString();
  const normalizedSymbols = new Set(symbols.map((s) => s.toUpperCase()));
  const rows = includeShared
    ? (getDb()
        .prepare(
          `SELECT * FROM learned_context
           WHERE superseded_by IS NULL AND risk_tier = 'fact'
             AND (user_id = ? OR scope = 'shared')`
        )
        .all(userId) as RawLearnedContextRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM learned_context
           WHERE superseded_by IS NULL AND risk_tier = 'fact' AND user_id = ?`
        )
        .all(userId) as RawLearnedContextRow[]);
  return rows
    .map(mapLearnedContext)
    .filter((r) => r.expiresAt === null || r.expiresAt > nowIso)
    .filter((r) => r.symbol === null || normalizedSymbols.has(r.symbol.toUpperCase()));
}

export function listLearnedContext(userId: string): LearnedContextRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM learned_context WHERE user_id = ? AND superseded_by IS NULL ORDER BY asserted_at DESC")
    .all(userId) as RawLearnedContextRow[];
  return rows.map(mapLearnedContext);
}

export function supersedeLearnedContext(oldId: string, newId: string): void {
  getDb().prepare("UPDATE learned_context SET superseded_by = ? WHERE id = ?").run(newId, oldId);
}

// ── RAG ingestion de-dup helpers ──────────────────────────────────────────────
// Keyed by (accession, doc_type) — globally unique for SEC filings, so no user scoping needed.

export interface IngestedAccessionRow {
  accession: string;
  docType: string;
  ticker: string;
  indexedAt: string;
  chunkCount: number;
}

/** Return true if this (accession, docType) pair has already been embedded. */
export function hasIngestedAccession(accession: string, docType: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM ingested_accessions WHERE accession = ? AND doc_type = ?")
    .get(accession, docType);
  return row != null;
}

/** Record a successfully-ingested accession so it is never re-embedded. */
export function insertIngestedAccession(accession: string, docType: string, ticker: string, chunkCount: number): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count) VALUES (?, ?, ?, ?, ?)"
    )
    .run(accession, docType, ticker, new Date().toISOString(), chunkCount);
}

/** List all ingested accessions (admin/diagnostic). */
export function listIngestedAccessions(limit = 200): IngestedAccessionRow[] {
  const rows = getDb()
    .prepare("SELECT accession, doc_type, ticker, indexed_at, chunk_count FROM ingested_accessions ORDER BY indexed_at DESC LIMIT ?")
    .all(limit) as Array<{ accession: string; doc_type: string; ticker: string; indexed_at: string; chunk_count: number }>;
  return rows.map((r) => ({ accession: r.accession, docType: r.doc_type, ticker: r.ticker, indexedAt: r.indexed_at, chunkCount: r.chunk_count }));
}

// ── document_chunks content-hash dedup ─────────────────────────────────────

/** Check whether a chunk with this content_hash has already been embedded. */
export function hasDocumentChunk(contentHash: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM document_chunks WHERE content_hash = ?")
    .get(contentHash);
  return row != null;
}

/** Batch-check which content_hashes are new (not yet stored). Returns the set of NEW hashes. */
export function filterNewDocumentChunks(
  hashes: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }>
): typeof hashes {
  if (hashes.length === 0) return [];
  // Build placeholders for IN clause — SQLite max is 999, well above any chunk batch.
  const placeholders = hashes.map(() => "?").join(",");
  const flatHashes = hashes.map((h) => h.content_hash);
  const existing = new Set<string>();
  const rows = getDb()
    .prepare(`SELECT content_hash FROM document_chunks WHERE content_hash IN (${placeholders})`)
    .all(...flatHashes) as Array<{ content_hash: string }>;
  for (const row of rows) existing.add(row.content_hash);
  return hashes.filter((h) => !existing.has(h.content_hash));
}

/** Record successfully-embedded chunks so their content_hash is never re-embedded. */
export function insertDocumentChunks(
  chunks: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }>
): void {
  if (chunks.length === 0) return;
  const stmt = getDb().prepare(
    "INSERT OR IGNORE INTO document_chunks (content_hash, symbol, source, chunk_id, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  const insertMany = getDb().transaction((rows: typeof chunks) => {
    for (const c of rows) stmt.run(c.content_hash, c.symbol, c.source, c.chunk_id, now);
  });
  insertMany(chunks);
}

/** Per-symbol chunk coverage stats (admin/diagnostic). */
export interface ChunkCoverageRow {
  symbol: string;
  chunkCount: number;
  latestAt: string;
}

export function getChunkCoverage(): ChunkCoverageRow[] {
  const rows = getDb()
    .prepare(
      "SELECT symbol, COUNT(*) as chunk_count, MAX(created_at) as latest_at FROM document_chunks GROUP BY symbol ORDER BY chunk_count DESC"
    )
    .all() as Array<{ symbol: string; chunk_count: number; latest_at: string }>;
  return rows.map((r) => ({ symbol: r.symbol, chunkCount: r.chunk_count, latestAt: r.latest_at }));
}

// ── learned_context_pending CRUD (risk-tier confirmation queue; userId-scoped) ──
// Every helper is ownership-scoped (WHERE user_id = ?). A queued row is a risk-tier candidate that is
// NOT in the brain — it only ever influences anything via the explicit human approve path, which
// applies it SAFELY (advisory promote / prompt append) and NEVER auto-mutates numeric policy.
interface RawLearnedContextPendingRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: string;
  risk_tier: string;
  classifier_reason: string | null;
  created_at: string;
  status: string;
  resolved_at: string | null;
}

function mapLearnedContextPending(row: RawLearnedContextPendingRow): LearnedContextPendingRow {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as LearnedContextPendingRow["scope"],
    kind: row.kind as LearnedContextPendingRow["kind"],
    subject: row.subject,
    symbol: row.symbol,
    value: row.value,
    source: row.source,
    origin: row.origin as LearnedContextPendingRow["origin"],
    riskTier: row.risk_tier as LearnedContextPendingRow["riskTier"],
    classifierReason: row.classifier_reason,
    createdAt: row.created_at,
    status: row.status as LearnedContextPendingRow["status"],
    resolvedAt: row.resolved_at
  };
}

export function insertPendingLearnedContext(row: LearnedContextPendingRow): LearnedContextPendingRow {
  getDb()
    .prepare(
      `INSERT INTO learned_context_pending
        (id, user_id, scope, kind, subject, symbol, value, source, origin, risk_tier, classifier_reason, created_at, status, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId,
      row.scope,
      row.kind,
      row.subject,
      row.symbol,
      row.value,
      row.source,
      row.origin,
      row.riskTier,
      row.classifierReason,
      row.createdAt,
      row.status,
      row.resolvedAt
    );
  return row;
}

export function listPendingLearnedContext(
  userId: string,
  status: LearnedContextPendingStatus = "pending"
): LearnedContextPendingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM learned_context_pending
       WHERE user_id = ? AND status = ?
       ORDER BY created_at DESC`
    )
    .all(userId, status) as RawLearnedContextPendingRow[];
  return rows.map(mapLearnedContextPending);
}

export function getPendingLearnedContext(id: string, userId: string): LearnedContextPendingRow | null {
  const row = getDb()
    .prepare("SELECT * FROM learned_context_pending WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawLearnedContextPendingRow | undefined;
  return row ? mapLearnedContextPending(row) : null;
}

/**
 * Ownership-scoped status transition. Returns true only when a row owned by `userId` was actually
 * updated (changes > 0) — so another user's row is a no-op false, and the API layer maps that to 404.
 */
export function setPendingLearnedContextStatus(
  id: string,
  userId: string,
  status: LearnedContextPendingStatus
): boolean {
  const resolvedAt = status === "pending" ? null : new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE learned_context_pending SET status = ?, resolved_at = ? WHERE id = ? AND user_id = ?")
    .run(status, resolvedAt, id, userId);
  return result.changes > 0;
}

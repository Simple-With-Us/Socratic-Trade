// db-lookahead-audit.ts — CRUD for the truncated-replay lookahead audit (freqtrade
// lookahead-analysis port). Schema lives in db.ts migrate() (versioned migration 75). The weekly
// lookahead-audit lane (src/lib/lookahead-audit.ts) recomputes point-in-time-reconstructable
// decision inputs (momentum/liquidity factor sub-scores from truncated OHLC; RAG evidence from an
// asOf-pinned strict replay) and persists one finding row per (user, decision, factor-or-field)
// with an honest three-way classification: clean | mismatch | unverifiable. Unverifiable rows are
// deliberate receipts of the coverage gap (factors with no point-in-time source), never noise to
// suppress. Advisory observability only — findings never gate a trade.
import "server-only";
import { getDb } from "./db";

export type LookaheadClassification = "clean" | "mismatch" | "unverifiable";

export interface LookaheadAuditFindingRow {
  userId: string;
  /** `${signal_snapshot audit id}:${symbol}` — one decision = one candidate in one snapshot. */
  decisionId: string;
  runId?: string;
  symbol: string;
  /** Factor sub-score name ('momentum', 'liquidity', …) or 'rag_evidence'. */
  factorOrField: string;
  classification: LookaheadClassification;
  /** Decision-time value (factor sub-score, or used-candidate count for 'rag_evidence'). */
  persistedValue?: number;
  /** Truncated-replay value (factor sub-score, or replay chunk count for 'rag_evidence'). */
  recomputedValue?: number;
  /** |persisted − recomputed| in sub-score points; 1 − Jaccard for 'rag_evidence'. */
  delta?: number;
  /** Reason / receipt payload (backtestSafety label, replay components, chunk id sets). */
  detail?: Record<string, unknown>;
  /** Decision snapshot timestamp (the point-in-time pin the replay used). */
  asOf?: string;
  createdAt: string;
}

function parseDetail(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Idempotent per-(user, decision, factor) write — a re-run pass overwrites, never duplicates. */
export function upsertLookaheadAuditFindings(
  rows: Array<Omit<LookaheadAuditFindingRow, "createdAt">>,
  now: string = new Date().toISOString()
): void {
  if (rows.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(
    `INSERT INTO lookahead_audit_findings (
       user_id, decision_id, run_id, symbol, factor_or_field, classification,
       persisted_value, recomputed_value, delta, detail, as_of, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, decision_id, factor_or_field) DO UPDATE SET
       run_id = excluded.run_id,
       symbol = excluded.symbol,
       classification = excluded.classification,
       persisted_value = excluded.persisted_value,
       recomputed_value = excluded.recomputed_value,
       delta = excluded.delta,
       detail = excluded.detail,
       as_of = excluded.as_of,
       created_at = excluded.created_at`
  );
  const writeAll = database.transaction(() => {
    for (const row of rows) {
      stmt.run(
        row.userId,
        row.decisionId,
        row.runId ?? null,
        row.symbol,
        row.factorOrField,
        row.classification,
        row.persistedValue ?? null,
        row.recomputedValue ?? null,
        row.delta ?? null,
        row.detail ? JSON.stringify(row.detail) : null,
        row.asOf ?? null,
        now
      );
    }
  });
  writeAll();
}

/** Findings for one user, newest pass first (stable within a pass by decision + field). */
export function listLookaheadAuditFindings(
  userId: string = "local",
  opts: { limit?: number } = {}
): LookaheadAuditFindingRow[] {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)));
  const rows = getDb()
    .prepare(
      `SELECT user_id, decision_id, run_id, symbol, factor_or_field, classification,
              persisted_value, recomputed_value, delta, detail, as_of, created_at
       FROM lookahead_audit_findings
       WHERE user_id = ?
       ORDER BY created_at DESC, decision_id ASC, factor_or_field ASC
       LIMIT ?`
    )
    .all(userId, limit) as Array<{
    user_id: string;
    decision_id: string;
    run_id: string | null;
    symbol: string;
    factor_or_field: string;
    classification: LookaheadClassification;
    persisted_value: number | null;
    recomputed_value: number | null;
    delta: number | null;
    detail: string | null;
    as_of: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    userId: row.user_id,
    decisionId: row.decision_id,
    ...(row.run_id != null ? { runId: row.run_id } : {}),
    symbol: row.symbol,
    factorOrField: row.factor_or_field,
    classification: row.classification,
    ...(row.persisted_value != null ? { persistedValue: row.persisted_value } : {}),
    ...(row.recomputed_value != null ? { recomputedValue: row.recomputed_value } : {}),
    ...(row.delta != null ? { delta: row.delta } : {}),
    ...(parseDetail(row.detail) ? { detail: parseDetail(row.detail) } : {}),
    ...(row.as_of != null ? { asOf: row.as_of } : {}),
    createdAt: row.created_at
  }));
}

/**
 * Classification counts for one user — the verdict input. When `sinceIso` is given, only findings
 * created at/after that stamp count (the aggregate verdict's trailing window; see
 * LOOKAHEAD_VERDICT_WINDOW_DAYS in lookahead-audit.ts). Omit it for the full-table count (tests,
 * diagnostics).
 */
export function countLookaheadFindingsByClassification(
  userId: string = "local",
  opts: { sinceIso?: string } = {}
): Record<LookaheadClassification, number> {
  const counts: Record<LookaheadClassification, number> = { clean: 0, mismatch: 0, unverifiable: 0 };
  const rows = opts.sinceIso
    ? (getDb()
        .prepare(
          "SELECT classification, COUNT(*) AS n FROM lookahead_audit_findings WHERE user_id = ? AND created_at >= ? GROUP BY classification"
        )
        .all(userId, opts.sinceIso) as Array<{ classification: string; n: number }>)
    : (getDb()
        .prepare(
          "SELECT classification, COUNT(*) AS n FROM lookahead_audit_findings WHERE user_id = ? GROUP BY classification"
        )
        .all(userId) as Array<{ classification: string; n: number }>);
  for (const row of rows) {
    if (row.classification in counts) counts[row.classification as LookaheadClassification] = row.n;
  }
  return counts;
}

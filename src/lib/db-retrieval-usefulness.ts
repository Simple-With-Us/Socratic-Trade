// db-retrieval-usefulness.ts — CRUD for the retrieval-usefulness join (handoff 4.1).
// Schema lives in db.ts migrate() (versioned migration 44). The scheduled incremental join
// (src/lib/retrieval-usefulness.ts) credits each vector id / doc_type / memory kind that was
// injected into a decision's prompts (ragAttributions on socratic_decisions) with that decision's
// matured multi-horizon outcome, exactly once per decision (the credited ledger makes passes
// idempotent). Aggregates are advisory observability + a bounded ranking nudge — never a gate.
import "server-only";
import { getDb } from "./db";

/** How an injected chunk reached the prompt. Derived deterministically from doc_type (the split
 * experience-memory.ts itself uses): 'coach-note' -> coaching, other episodic decision docs ->
 * analog, everything else (filings/context RAG) -> context. */
export type RetrievalMemoryKind = "analog" | "coaching" | "context";

export interface RetrievalUsefulnessStatRow {
  userId: string;
  docType: string;
  memoryKind: string;
  /** '' = the (docType, memoryKind) kind-level aggregate; otherwise a specific vector/chunk id. */
  docId: string;
  /** Outcome horizon this row aggregates ('15m'|'1h'|'1d'|'1w' or 'headline' = the case's
   * top-level returnPct). Alpha-companion rows carry a ':alpha' suffix (e.g. '1d:alpha') and
   * aggregate spyExcessPct instead of returnPct — free-text column, no schema change. */
  horizon: string;
  samples: number;
  wins: number;
  losses: number;
  returnPctSum: number;
  updatedAt: string;
  /** Mean side-adjusted return of decisions this (kind|doc) informed, at this horizon. */
  meanReturnPct: number;
  /** wins / (wins + losses); undefined when no signed outcome has been credited yet. */
  hitRate?: number;
}

/** One increment the join writes: an attribution unit credited with one horizon outcome. */
export interface RetrievalUsefulnessCredit {
  docType: string;
  memoryKind: string;
  /** Vector/chunk id for the per-doc row; omit to write only the kind-level ('') row. */
  docId?: string;
  horizon: string;
  returnPct: number;
}

/** Minimal decision projection the join needs (parsed from socratic_decisions JSON columns). */
export interface DecisionForUsefulnessJoin {
  id: string;
  updatedAt: string;
  ragAttributions: Array<{ chunkId?: string; docType?: string }>;
  outcome: {
    status: string;
    returnPct?: number;
    outcomes?: Array<{ horizon: string; returnPct?: number; spyExcessPct?: number; resolution: string }>;
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Decision cases the join still owes credit: terminal outcome (won/lost/flat/unknown/unresolvable
 * — 'unresolvable' is included so the ledger stops rescanning it, it just contributes no returns),
 * non-empty ragAttributions, and not yet in the credited ledger. Oldest-updated first, bounded.
 * The credited-ledger anti-join IS the watermark: re-running a pass re-reads nothing it already
 * credited, and later row rewrites (lessons, coach notes) can't double-credit.
 */
export function listDecisionsForUsefulnessJoin(
  userId: string = "local",
  opts: { limit?: number } = {}
): DecisionForUsefulnessJoin[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.updated_at, d.rag_attributions, d.outcome
       FROM socratic_decisions d
       WHERE d.user_id = ?
         AND json_extract(d.outcome, '$.status') IN ('won', 'lost', 'flat', 'unknown', 'unresolvable')
         AND d.rag_attributions IS NOT NULL
         AND d.rag_attributions NOT IN ('', '[]')
         AND NOT EXISTS (
           SELECT 1 FROM retrieval_usefulness_credited c
           WHERE c.user_id = d.user_id AND c.decision_id = d.id
         )
       ORDER BY d.updated_at ASC, d.rowid ASC
       LIMIT ?`
    )
    .all(userId, limit) as Array<{ id: string; updated_at: string; rag_attributions: string; outcome: string | null }>;
  return rows
    .map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
      ragAttributions: parseJson<DecisionForUsefulnessJoin["ragAttributions"]>(row.rag_attributions, []),
      outcome: parseJson<DecisionForUsefulnessJoin["outcome"] | undefined>(row.outcome, undefined)
    }))
    .filter((row): row is DecisionForUsefulnessJoin => Boolean(row.outcome) && row.ragAttributions.length > 0);
}

/**
 * Atomically mark a decision credited and apply its stat increments. Returns false (writing
 * nothing) when the decision was already credited — the idempotency guarantee.
 */
export function creditRetrievalUsefulness(
  userId: string,
  decisionId: string,
  credits: RetrievalUsefulnessCredit[],
  now: string = new Date().toISOString()
): boolean {
  const db = getDb();
  const insertCredited = db.prepare(
    "INSERT OR IGNORE INTO retrieval_usefulness_credited (user_id, decision_id, credited_at) VALUES (?, ?, ?)"
  );
  const upsertStat = db.prepare(
    `INSERT INTO retrieval_usefulness_stats (
       user_id, doc_type, memory_kind, doc_id, horizon, samples, wins, losses, return_pct_sum, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(user_id, doc_type, memory_kind, doc_id, horizon) DO UPDATE SET
       samples = samples + 1,
       wins = wins + excluded.wins,
       losses = losses + excluded.losses,
       return_pct_sum = return_pct_sum + excluded.return_pct_sum,
       updated_at = excluded.updated_at`
  );
  const apply = db.transaction((rows: RetrievalUsefulnessCredit[]) => {
    const inserted = insertCredited.run(userId, decisionId, now);
    if (inserted.changes === 0) return false; // already credited — write nothing twice
    for (const credit of rows) {
      const win = credit.returnPct > 0 ? 1 : 0;
      const loss = credit.returnPct < 0 ? 1 : 0;
      // Kind-level aggregate row (doc_id '') always; per-doc row only when the id is known.
      upsertStat.run(userId, credit.docType, credit.memoryKind, "", credit.horizon, win, loss, credit.returnPct, now);
      if (credit.docId) {
        upsertStat.run(userId, credit.docType, credit.memoryKind, credit.docId, credit.horizon, win, loss, credit.returnPct, now);
      }
    }
    return true;
  });
  return apply(credits) as boolean;
}

/** Read aggregates. Defaults to the kind-level ('') rows; pass docId to inspect one document. */
export function getRetrievalUsefulnessStats(
  userId: string = "local",
  opts: { docId?: string; horizon?: string } = {}
): RetrievalUsefulnessStatRow[] {
  const clauses = ["user_id = ?", "doc_id = ?"];
  const args: unknown[] = [userId, opts.docId ?? ""];
  if (opts.horizon) {
    clauses.push("horizon = ?");
    args.push(opts.horizon);
  }
  const rows = getDb()
    .prepare(
      `SELECT user_id, doc_type, memory_kind, doc_id, horizon, samples, wins, losses, return_pct_sum, updated_at
       FROM retrieval_usefulness_stats WHERE ${clauses.join(" AND ")}
       ORDER BY doc_type ASC, memory_kind ASC, horizon ASC`
    )
    .all(...args) as Array<{
    user_id: string;
    doc_type: string;
    memory_kind: string;
    doc_id: string;
    horizon: string;
    samples: number;
    wins: number;
    losses: number;
    return_pct_sum: number;
    updated_at: string;
  }>;
  return rows.map((row) => {
    const signed = row.wins + row.losses;
    return {
      userId: row.user_id,
      docType: row.doc_type,
      memoryKind: row.memory_kind,
      docId: row.doc_id,
      horizon: row.horizon,
      samples: row.samples,
      wins: row.wins,
      losses: row.losses,
      returnPctSum: row.return_pct_sum,
      updatedAt: row.updated_at,
      meanReturnPct: row.samples > 0 ? Number((row.return_pct_sum / row.samples).toFixed(4)) : 0,
      ...(signed > 0 ? { hitRate: Number((row.wins / signed).toFixed(4)) } : {})
    };
  });
}

/** Compact human-readable summary of the kind-level 'headline' aggregates (ops/debug surface). */
export function getRetrievalUsefulnessSummary(userId: string = "local"): {
  creditedDecisions: number;
  kinds: Array<{ docType: string; memoryKind: string; samples: number; hitRate?: number; meanReturnPct: number }>;
} {
  const credited = getDb()
    .prepare("SELECT COUNT(*) AS n FROM retrieval_usefulness_credited WHERE user_id = ?")
    .get(userId) as { n: number };
  const kinds = getRetrievalUsefulnessStats(userId, { horizon: "headline" }).map((row) => ({
    docType: row.docType,
    memoryKind: row.memoryKind,
    samples: row.samples,
    ...(row.hitRate !== undefined ? { hitRate: row.hitRate } : {}),
    meanReturnPct: row.meanReturnPct
  }));
  return { creditedDecisions: credited.n, kinds };
}

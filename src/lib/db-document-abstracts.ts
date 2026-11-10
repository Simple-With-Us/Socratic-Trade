import "server-only";
import { getDb } from "./db";

export interface DocumentAbstract {
  id: string;
  sourceType: "10k-delta" | "10q-delta" | "earnings-summary" | "8k-brief" | string;
  ticker: string;
  accessionOrEventId: string;
  headline: string;
  summaryText: string;
  guidanceJson?: string;
  driversJson?: string;
  risksJson?: string;
  sourceChunkIds: string[];
  createdAt: string;
  modelUsed: string;
}

export function insertDocumentAbstract(item: DocumentAbstract): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO document_abstracts (
      id, source_type, ticker, accession_or_event_id, headline, summary_text,
      guidance_json, drivers_json, risks_json, source_chunk_ids, created_at, model_used
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    item.id,
    item.sourceType,
    item.ticker.toUpperCase(),
    item.accessionOrEventId,
    item.headline,
    item.summaryText,
    item.guidanceJson ?? null,
    item.driversJson ?? null,
    item.risksJson ?? null,
    JSON.stringify(item.sourceChunkIds ?? []),
    item.createdAt || new Date().toISOString(),
    item.modelUsed
  );
}

/** Remove a single abstract so a newer extractive model can rewrite it. */
export function deleteDocumentAbstractByAccessionAndSource(
  accessionOrEventId: string,
  sourceType: string
): number {
  const db = getDb();
  const result = db
    .prepare(
      "DELETE FROM document_abstracts WHERE accession_or_event_id = ? AND source_type = ?"
    )
    .run(accessionOrEventId, sourceType);
  return Number(result.changes ?? 0);
}

export function getDocumentAbstractsForTicker(ticker: string, limit = 20): DocumentAbstract[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM document_abstracts
    WHERE ticker = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(ticker.toUpperCase(), limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    sourceType: r.source_type,
    ticker: r.ticker,
    accessionOrEventId: r.accession_or_event_id,
    headline: r.headline,
    summaryText: r.summary_text,
    guidanceJson: r.guidance_json ?? undefined,
    driversJson: r.drivers_json ?? undefined,
    risksJson: r.risks_json ?? undefined,
    sourceChunkIds: r.source_chunk_ids ? JSON.parse(r.source_chunk_ids) : [],
    createdAt: r.created_at,
    modelUsed: r.model_used
  }));
}

export function getDocumentAbstractByAccession(accessionOrEventId: string): DocumentAbstract | undefined {
  const db = getDb();
  const r = db.prepare(`
    SELECT * FROM document_abstracts
    WHERE accession_or_event_id = ?
    LIMIT 1
  `).get(accessionOrEventId) as any;

  if (!r) return undefined;

  return {
    id: r.id,
    sourceType: r.source_type,
    ticker: r.ticker,
    accessionOrEventId: r.accession_or_event_id,
    headline: r.headline,
    summaryText: r.summary_text,
    guidanceJson: r.guidance_json ?? undefined,
    driversJson: r.drivers_json ?? undefined,
    risksJson: r.risks_json ?? undefined,
    sourceChunkIds: r.source_chunk_ids ? JSON.parse(r.source_chunk_ids) : [],
    createdAt: r.created_at,
    modelUsed: r.model_used
  };
}

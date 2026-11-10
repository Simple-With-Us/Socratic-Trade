// Local-complete seam for corpus-storage PR A.
// Artifact + full FTS (bare SEC accession) + ledger persist without storeDocument(full body).

import { getDb } from "../db";
import { insertIngestedAccession } from "../db-learning";
import {
  bareSecAccession,
  pineconeWriteClass,
  type PineconeWriteClass
} from "./pinecone-write-class";
import { mirrorFtsChunksBounded, type FtsMirrorRow } from "./mirror-fts-bounded";

export interface LocalCompleteChunk {
  content_hash: string;
  text: string;
}

export interface PersistLocalCompleteInput {
  ticker: string;
  accession: string;
  docType: string;
  chunks: readonly LocalCompleteChunk[];
  source?: string;
  pineconeWriteClass?: PineconeWriteClass;
  pineconeVectorCount?: number;
  /** When false, write FTS only.  Full-body default still ledgers after the body commit. */
  recordLedger?: boolean;
}

export interface PersistLocalCompleteResult {
  accession: string;
  ftsRows: number;
  writeClass: PineconeWriteClass;
  ftsMirrorComplete: boolean;
  ftsMirrorOffset: number;
  abortedByStrategy: boolean;
}

export function pinBareSecAccession(accession: string): string {
  return bareSecAccession(accession) ?? accession.trim();
}

function buildFtsMirrorRows(
  input: PersistLocalCompleteInput,
  ticker: string,
  accession: string,
  source: string
): FtsMirrorRow[] {
  const rows: FtsMirrorRow[] = [];
  for (const chunk of input.chunks) {
    const hash = String(chunk.content_hash ?? "").trim();
    const text = String(chunk.text ?? "");
    if (!hash || !text.trim()) continue;
    rows.push({
      contentHash: hash,
      symbol: ticker,
      source,
      accession,
      text
    });
  }
  return rows;
}

export async function persistLocalComplete(
  input: PersistLocalCompleteInput
): Promise<PersistLocalCompleteResult> {
  const ticker = input.ticker.trim().toUpperCase();
  const accession = pinBareSecAccession(input.accession);
  const source = input.source ?? "sec-edgar";
  const writeClass = input.pineconeWriteClass ?? pineconeWriteClass();
  const ftsRows = buildFtsMirrorRows(input, ticker, accession, source);
  const mirror = await mirrorFtsChunksBounded(ftsRows, {
    resumeKey: { symbol: ticker, source, accession }
  });
  if (mirror.complete && input.recordLedger !== false) {
    insertIngestedAccession(accession, input.docType, ticker, ftsRows.length, {
      pineconeWriteClass: writeClass,
      pineconeVectorCount: input.pineconeVectorCount ?? 0
    });
  }
  return {
    accession,
    ftsRows: mirror.offset,
    writeClass,
    ftsMirrorComplete: mirror.complete,
    ftsMirrorOffset: mirror.offset,
    abortedByStrategy: mirror.abortedByStrategy
  };
}

export function hasLocalFilingCopy(accession: string): boolean {
  const bare = pinBareSecAccession(accession);
  const db = getDb();
  const fts = db.prepare(`
    SELECT 1 FROM document_chunks_fts
    WHERE accession = ?
       OR accession GLOB ('*:' || ? || ':*')
       OR accession GLOB (? || ':*')
    LIMIT 1
  `).get(bare, bare, bare);
  if (fts) return true;
  try {
    const abs = db.prepare(
      "SELECT 1 FROM document_abstracts WHERE accession_or_event_id = ? LIMIT 1"
    ).get(bare);
    if (abs) return true;
  } catch {
    // abstracts table may be absent in very old test DBs
  }
  try {
    const art = db.prepare("SELECT 1 FROM sec_artifacts WHERE accession = ? LIMIT 1").get(bare);
    if (art) return true;
  } catch {
    // artifacts table may be absent
  }
  try {
    const call = db.prepare(`
      SELECT 1 FROM earningscalls_transcripts
      WHERE content IS NOT NULL
        AND (
          plaintext_length > 80
          OR (plaintext_length IS NULL AND length(content) > 80)
        )
        AND (
          lower(symbol) = lower(?)
          OR source_meta LIKE ?
        )
      LIMIT 1
    `).get(bare, `%${bare}%`);
    if (call) return true;
  } catch {
    // transcript cache may be absent
  }
  return false;
}

export function countLocalFtsRows(accession: string): number {
  const bare = pinBareSecAccession(accession);
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM document_chunks_fts
    WHERE accession = ?
       OR accession GLOB ('*:' || ? || ':*')
       OR accession GLOB (? || ':*')
  `).get(bare, bare, bare) as { n: number } | undefined;
  return row?.n ?? 0;
}

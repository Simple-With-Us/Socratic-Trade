import { getDb } from "../../src/lib/db";
import { envFlagOn } from "../../src/lib/rag/env-flag";
import { getVectorStoreStats, numericEnv } from "../../src/lib/vector-db";
import { eightKRagLimit } from "../../src/lib/web-sources/sec8k";
import { disclosureRagEnabled } from "../../src/lib/web-sources/disclosure-rag";

interface DocTypeRow {
  doc_type: string;
  count: number;
  distinct_tickers: number;
  min_indexed_at: string;
  max_indexed_at: string;
}

interface SymbolCoverageRow {
  symbol: string;
  chunk_count: number;
  latest_at: string;
}

function median(sorted: string[]): string {
  if (sorted.length === 0) return "";
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? sorted[mid - 1]! : sorted[mid]!;
}

function reportByDocType(): DocTypeRow[] {
  return getDb()
    .prepare(
      `SELECT doc_type,
              COUNT(*) as count,
              COUNT(DISTINCT ticker) as distinct_tickers,
              MIN(indexed_at) as min_indexed_at,
              MAX(indexed_at) as max_indexed_at
       FROM ingested_accessions
       GROUP BY doc_type
       ORDER BY count DESC`
    )
    .all() as DocTypeRow[];
}

function medianIndexedAtByDocType(docType: string): string {
  const rows = getDb()
    .prepare("SELECT indexed_at FROM ingested_accessions WHERE doc_type = ? ORDER BY indexed_at ASC")
    .all(docType) as Array<{ indexed_at: string }>;
  return median(rows.map((r) => r.indexed_at));
}

function reportBySymbol(topN = 50): SymbolCoverageRow[] {
  return getDb()
    .prepare(
      `SELECT symbol,
              COUNT(*) as chunk_count,
              MAX(created_at) as latest_at
       FROM document_chunks
       GROUP BY symbol
       ORDER BY chunk_count DESC
       LIMIT ?`
    )
    .all(topN) as SymbolCoverageRow[];
}

/** Matches isFreeTier() in src/lib/web-sources/sec-filings.ts — paid tier
 *  (VECTOR_EMBED_BATCH_DELAY_MS ≤ 5000) uses higher filing caps. */
function isFreeTier(): boolean {
  const delay = Number(process.env.VECTOR_EMBED_BATCH_DELAY_MS ?? 21_000);
  return !Number.isFinite(delay) || delay > 5000;
}

function getConfigurationSummary() {
  // Resolve effective configuration matching the ingest path's defaults
  // rather than printing "unset" when a default is silently in effect.
  // Defaults sourced from:
  //   vector-db.ts:  RAG_INGEST_BUDGET_ENABLED → true,  RAG_PINECONE_WRITE_BUDGET_ENABLED → true
  //                   RAG_INGEST_MAX_TEXTS_PER_DAY → 20,000,  RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY → 200,000
  //   sec-filings.ts: SEC_FILING_RAG_MAX_PER_RUN → 1 (free) / 200 (paid),  SEC_FILING_INGEST_TTL_HOURS → 168
  //   sec8k.ts:       VECTOR_STORECONTEXTS_DEDUP → true,  WEB_SOURCE_SEC8K_RAG_LIMIT → 16,
  //                   WEB_SOURCE_SEC8K_FULL_BODY → off
  //   disclosure-rag.ts: RAG_EMBED_DISCLOSURES → false
  return {
    // Use == null (not truthiness) so that a blank env var (e.g. RAG_INGEST_MAX_TEXTS_PER_DAY=)
    // is NOT treated as "unset" — it goes through the resolver, which parses and clamps
    // to match what the ingest path actually uses.
    RAG_INGEST_BUDGET_ENABLED: process.env.RAG_INGEST_BUDGET_ENABLED == null
      ? "on (default)"
      : `${envFlagOn("RAG_INGEST_BUDGET_ENABLED", true) ? "on" : "off"}  (env: ${process.env.RAG_INGEST_BUDGET_ENABLED})`,
    RAG_INGEST_MAX_TEXTS_PER_DAY: process.env.RAG_INGEST_MAX_TEXTS_PER_DAY == null
      ? "20,000 (default)"
      : `${numericEnv("RAG_INGEST_MAX_TEXTS_PER_DAY", 20_000, 1).toLocaleString()}  (raw env: "${process.env.RAG_INGEST_MAX_TEXTS_PER_DAY}")`,
    RAG_PINECONE_WRITE_BUDGET_ENABLED: process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED == null
      ? "on (default)"
      : `${envFlagOn("RAG_PINECONE_WRITE_BUDGET_ENABLED", true) ? "on" : "off"}  (env: ${process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED})`,
    RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY: process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY == null
      ? "200,000 (default)"
      : `${numericEnv("RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY", 200_000, 1).toLocaleString()}  (raw env: "${process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY}")`,
    VECTOR_STORECONTEXTS_DEDUP: process.env.VECTOR_STORECONTEXTS_DEDUP == null
      ? "on (default)"
      : `${envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true) ? "on" : "off"}  (env: ${process.env.VECTOR_STORECONTEXTS_DEDUP})`,
    SEC_FILING_RAG_MAX_PER_RUN: process.env.SEC_FILING_RAG_MAX_PER_RUN == null
      ? "1 (free-tier default, 200 paid)"
      : `${numericEnv("SEC_FILING_RAG_MAX_PER_RUN", isFreeTier() ? 1 : 200, 1).toLocaleString()}  (raw env: "${process.env.SEC_FILING_RAG_MAX_PER_RUN}")`,
    SEC_FILING_INGEST_TTL_HOURS: process.env.SEC_FILING_INGEST_TTL_HOURS == null
      ? "168 (default, 7 days)"
      : `${numericEnv("SEC_FILING_INGEST_TTL_HOURS", 168, 1).toLocaleString()} h  (raw env: "${process.env.SEC_FILING_INGEST_TTL_HOURS}")`,
    WEB_SOURCE_SEC8K_RAG_LIMIT: process.env.WEB_SOURCE_SEC8K_RAG_LIMIT == null
      ? `${eightKRagLimit()} (default)`
      : `${process.env.WEB_SOURCE_SEC8K_RAG_LIMIT} (raw)`,
    WEB_SOURCE_SEC8K_FULL_BODY: process.env.WEB_SOURCE_SEC8K_FULL_BODY == null
      ? "off (default)"
      : `${process.env.WEB_SOURCE_SEC8K_FULL_BODY} (raw)`,
    RAG_EMBED_DISCLOSURES: process.env.RAG_EMBED_DISCLOSURES == null
      ? "off (default)"
      : `${disclosureRagEnabled() ? "on" : "off"}  (raw env: "${process.env.RAG_EMBED_DISCLOSURES}")`
  };
}

async function performParityCheck() {
  const accessions = getDb()
    .prepare("SELECT accession, doc_type, ticker, chunk_count FROM ingested_accessions")
    .all() as Array<{ accession: string; doc_type: string; ticker: string; chunk_count: number }>;

  const chunks = getDb()
    .prepare("SELECT chunk_id, symbol, source FROM document_chunks")
    .all() as Array<{ chunk_id: string; symbol: string; source: string }>;

  console.log("── Parity & Integrity Analysis ──────────────────────────────");
  console.log(`  Total ingested accession markers: ${accessions.length}`);
  console.log(`  Total document chunk records: ${chunks.length}`);

  // Doc types whose ingestion path does NOT embed the accession in the chunk_id.
  // The missing-chunks substring check would FALSE-flag these, so we skip them.
  // See ingestEightKBody: no doc_id passed to storeDocument → chunk_id is UUID-based.
  const NON_ACCESSION_BEARING_DOC_TYPES = new Set(["8-K-body"]);

  // Chunk sources that intentionally have no ingested_accessions marker.
  // sec8k-summary chunks embed the SEC accession in chunk_id but the summary
  // path never inserts an accession ledger row, so the orphan check would
  // false-flag every valid summary chunk.
  const ORPHAN_EXEMPT_SOURCES = new Set(["sec8k-summary:sec-8k"]);

  // Build O(1) lookup sets to avoid quadratic nested scans.
  const accessionSet = new Set(accessions.map(a => a.accession));
  const accessionInChunkIds = new Set<string>();
  for (const chunk of chunks) {
    const match = chunk.chunk_id.match(/(\d{10}-\d{2}-\d{6})/);
    if (match) accessionInChunkIds.add(match[1]!);
  }

  let missingChunks = 0;
  let zeroChunkAccessions = 0;
  for (const acc of accessions) {
    if (NON_ACCESSION_BEARING_DOC_TYPES.has(acc.doc_type)) continue;
    const hasChunk = accessionInChunkIds.has(acc.accession);
    if (!hasChunk) {
      if (acc.chunk_count > 0) {
        console.log(`  ⚠️  [Missing Chunks] Accession ${acc.accession} (${acc.doc_type}) for ${acc.ticker} has 0 local chunks recorded.`);
        missingChunks++;
      } else {
        zeroChunkAccessions++;
      }
    }
  }

  let orphans = 0;
  for (const chunk of chunks) {
    if (ORPHAN_EXEMPT_SOURCES.has(chunk.source)) continue;
    const match = chunk.chunk_id.match(/(\d{10}-\d{2}-\d{6})/);
    if (match) {
      const accession = match[1]!;
      if (!accessionSet.has(accession)) {
        console.log(`  ⚠️  [Orphan Chunk] Chunk "${chunk.chunk_id}" (${chunk.symbol}) has no matching ingested_accessions marker.`);
        orphans++;
      }
    }
  }

  const zeroChunkNote = zeroChunkAccessions > 0 ? `, ${zeroChunkAccessions} zero-chunk accessions (retry suppressed)` : "0 zero-chunk accessions";
  console.log(`  Manifest-to-chunk parity: ${missingChunks} accessions missing chunks, ${orphans} orphan chunks, ${zeroChunkNote}.`);
}

async function main(): Promise<void> {
  console.log("\n▶ RAG Authenticated Corpus Census Report");
  console.log(`  Database: ${process.env.DATABASE_URL ?? "file:./data/app.db (default)"}\n`);

  console.log("── Active Runtime Configuration ──────────────────────────────");
  const config = getConfigurationSummary();
  for (const [k, v] of Object.entries(config)) {
    console.log(`  ${k.padEnd(40)} : ${v}`);
  }
  console.log("");

  const byDocType = reportByDocType();
  console.log("── SQLite Accession Metadata (ingested_accessions) ──────────");
  if (byDocType.length === 0) {
    console.log("  (no ingested_accessions rows — nothing has been ingested yet)");
  } else {
    console.log(
      `  ${"DOC_TYPE".padEnd(16)} ${"COUNT".padStart(7)} ${"TICKERS".padStart(8)}  ${"MIN_INDEXED".padEnd(20)} ${"MEDIAN_INDEXED".padEnd(20)} ${"MAX_INDEXED".padEnd(20)}`
    );
    for (const row of byDocType) {
      const med = medianIndexedAtByDocType(row.doc_type);
      console.log(
        `  ${row.doc_type.padEnd(16)} ${String(row.count).padStart(7)} ${String(row.distinct_tickers).padStart(8)}  ${row.min_indexed_at.padEnd(20)} ${med.padEnd(20)} ${row.max_indexed_at.padEnd(20)}`
      );
    }
  }
  console.log("");

  const bySymbol = reportBySymbol(50);
  console.log("── SQLite Chunk Records by Symbol (document_chunks, top 50) ──");
  if (bySymbol.length === 0) {
    console.log("  (no document_chunks rows — no chunks embedded yet)");
  } else {
    console.log(`  ${"SYMBOL".padEnd(10)} ${"CHUNKS".padStart(8)}  ${"LATEST_INDEXED".padEnd(24)}`);
    for (const row of bySymbol) {
      console.log(`  ${row.symbol.padEnd(10)} ${String(row.chunk_count).padStart(8)}  ${row.latest_at.padEnd(24)}`);
    }
  }
  console.log("");

  await performParityCheck();

  try {
    const stats = await getVectorStoreStats("local");
    console.log("\n── Live Pinecone Vector Store Stats ─────────────────────────");
    console.log(`  Index Name  : ${stats.indexName}`);
    console.log(`  Configured  : ${stats.configured}`);
    console.log(`  Exists      : ${stats.exists ?? "unknown"}`);
    if (stats.totalVectorCount != null) console.log(`  Total Vectors: ${stats.totalVectorCount}`);
    if (stats.dimension != null) console.log(`  Dimension    : ${stats.dimension}`);
    if (stats.error) console.log(`  Error       : ${stats.error}`);
  } catch (err) {
    console.log(`\n(Could not retrieve Pinecone stats: ${err instanceof Error ? err.message : String(err)})`);
  }

  console.log("\n══ Done ══════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("Census script crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});

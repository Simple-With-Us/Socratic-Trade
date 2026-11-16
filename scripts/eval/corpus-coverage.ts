/**
 * Corpus coverage & freshness report (R15, 2026-07-01 RAG backlog).
 *
 * There's no way today to answer "what does the RAG corpus actually know, how fresh is it, and
 * which symbols the user cares about have ZERO coverage?" This offline script answers that from
 * SQLite alone (`ingested_accessions` + `document_chunks`) — no Pinecone/Voyage key required —
 * and optionally cross-checks live `describeIndexStats` when a Pinecone key IS configured.
 *
 * Usage:
 *   npm run eval:corpus-coverage
 *   DATABASE_URL=file:./data/app.db npm run eval:corpus-coverage   # against the real dev DB
 *
 * NOTE on `as_of`/`acceptance_datetime`: neither `ingested_accessions` nor `document_chunks`
 * store the filing's point-in-time date — only `indexed_at`/`created_at` (when THIS process
 * embedded it). This report uses `indexed_at` as an ingest-recency proxy and is explicit about
 * that limitation rather than pretending it's filing freshness; a corpus-content freshness report
 * would need a schema change (out of scope here — see the rollout note).
 */

// DB bootstrap: default to the app's dev DB when DATABASE_URL isn't set, matching the intent of
// "run this as an operator diagnostic against real data" — unlike the test suite, this script is
// NOT expected to run against a temp/isolated DB by default (an operator wants real numbers).
import { getDb } from "../../src/lib/db";

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
  const rows = getDb()
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
  return rows;
}

function medianIndexedAtByDocType(docType: string): string {
  const rows = getDb()
    .prepare("SELECT indexed_at FROM ingested_accessions WHERE doc_type = ? ORDER BY indexed_at ASC")
    .all(docType) as Array<{ indexed_at: string }>;
  return median(rows.map((r) => r.indexed_at));
}

function reportBySymbol(topN = 20): SymbolCoverageRow[] {
  const rows = getDb()
    .prepare(
      "SELECT symbol, COUNT(*) as chunk_count, MAX(created_at) as latest_at FROM document_chunks GROUP BY symbol ORDER BY chunk_count DESC LIMIT ?"
    )
    .all(topN) as SymbolCoverageRow[];
  return rows;
}

function watchlistSymbolsWithZeroCoverage(): string[] {
  const watchlistSymbols = getDb()
    .prepare("SELECT DISTINCT symbol FROM user_watchlist")
    .all() as Array<{ symbol: string }>;
  const coveredSymbols = new Set(
    (getDb().prepare("SELECT DISTINCT symbol FROM document_chunks").all() as Array<{ symbol: string }>).map((r) => r.symbol)
  );
  return watchlistSymbols.map((r) => r.symbol).filter((s) => !coveredSymbols.has(s));
}

async function tryLivePineconeStats(): Promise<void> {
  try {
    const { getVectorStoreStats } = await import("../../src/lib/vector-db");
    const stats = await getVectorStoreStats("local");
    if (!stats.configured) {
      console.log("\n(Pinecone/Voyage keys not configured — skipping live index-stats cross-check.)");
      return;
    }
    console.log("\n── Live Pinecone index stats (describeIndexStats) ──────────");
    console.log(`  index: ${stats.indexName}`);
    console.log(`  exists: ${stats.exists ?? "unknown"}`);
    if (stats.totalVectorCount != null) console.log(`  totalVectorCount: ${stats.totalVectorCount}`);
    if (stats.dimension != null) console.log(`  dimension: ${stats.dimension}`);
    if (stats.error) console.log(`  error: ${stats.error}`);
  } catch (err) {
    console.log(`\n(Could not fetch live Pinecone stats: ${err instanceof Error ? err.message : String(err)})`);
  }
}

async function main(): Promise<void> {
  console.log("\n▶ RAG corpus coverage & freshness report");
  console.log(`  database: ${process.env.DATABASE_URL ?? "file:./data/app.db (default)"}\n`);

  const byDocType = reportByDocType();
  console.log("── Coverage by doc_type (source: ingested_accessions) ───────");
  if (byDocType.length === 0) {
    console.log("  (no ingested_accessions rows — nothing has been ingested via the accession-tracked path yet)");
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
  console.log(
    "\n  NOTE: *_indexed columns are ingest-time (when this process embedded the filing), NOT the\n" +
    "  filing's own acceptance/publish date — no schema currently stores that in aggregate form.\n"
  );

  const bySymbol = reportBySymbol();
  console.log("── Top symbols by chunk count (source: document_chunks) ─────");
  if (bySymbol.length === 0) {
    console.log("  (no document_chunks rows — nothing has been chunk-ingested yet)");
  } else {
    console.log(`  ${"SYMBOL".padEnd(10)} ${"CHUNKS".padStart(8)}  ${"LATEST".padEnd(24)}`);
    for (const row of bySymbol) {
      console.log(`  ${row.symbol.padEnd(10)} ${String(row.chunk_count).padStart(8)}  ${row.latest_at.padEnd(24)}`);
    }
  }

  const zeroCoverage = watchlistSymbolsWithZeroCoverage();
  console.log("\n── Watchlist symbols with ZERO corpus coverage ───────────────");
  if (zeroCoverage.length === 0) {
    console.log("  (none — every watchlisted symbol across every user has at least one indexed chunk, OR no watchlist rows exist)");
  } else {
    console.log(`  ${zeroCoverage.join(", ")}`);
  }

  await tryLivePineconeStats();

  console.log("\n══ Done ══════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("Corpus coverage report crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/lib/db";
import { normalizeSymbol } from "../src/lib/money";

// Per repo convention every test file points DATABASE_URL at its own temp SQLite DB.
// Without this the suite would open the default file:./data/app.db and the DELETE FROM
// statements below would wipe the worktree's real dev database.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-reindex-all-${randomUUID()}.db`)}`;
});

describe("Reindex All Filings and API routing", () => {
  beforeEach(() => {
    const db = getDb();
    // Clean up tables
    db.prepare("DELETE FROM sec_filings").run();
    db.prepare("DELETE FROM sec_artifacts").run();
    db.prepare("DELETE FROM ingested_accessions").run();
    db.prepare("DELETE FROM document_chunks").run();
    db.prepare("DELETE FROM chunk_occurrences").run();
  });

  afterEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM sec_filings").run();
    db.prepare("DELETE FROM sec_artifacts").run();
    db.prepare("DELETE FROM ingested_accessions").run();
    db.prepare("DELETE FROM document_chunks").run();
    db.prepare("DELETE FROM chunk_occurrences").run();
  });

  it("should query all symbols from both sec_filings and ingested_accessions", () => {
    const db = getDb();

    // Insert mock filings
    db.prepare(`
      INSERT INTO sec_filings (accession, cik, ticker, form, filed_at, accepted_at, status, created_at, updated_at)
      VALUES ('acc-1', 'cik-1', 'AAPL', '10-K', '2025-01-01', '2025-01-01', 'complete', '2025-01-01', '2025-01-01')
    `).run();

    db.prepare(`
      INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
      VALUES ('acc-2', '10-Q', 'MSFT', '2025-01-01', 5)
    `).run();

    // Resolve all tickers using the same logic as the route
    const tickers = new Set<string>();
    const filingsTickers = db.prepare("SELECT DISTINCT ticker FROM sec_filings").all() as { ticker: string }[];
    for (const r of filingsTickers) if (r.ticker) tickers.add(r.ticker);

    const hasIngested = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ingested_accessions'").get();
    if (hasIngested) {
      const legacyTickers = db.prepare("SELECT DISTINCT ticker FROM ingested_accessions").all() as { ticker: string }[];
      for (const r of legacyTickers) if (r.ticker) tickers.add(r.ticker);
    }

    const symbols = Array.from(tickers).map((s) => normalizeSymbol(s));
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("MSFT");
    expect(symbols).toHaveLength(2);
  });

  it("should clear cache records and reset status to discovered in batches", () => {
    const db = getDb();

    // Setup mock filings, chunks, and occurrences
    db.prepare(`
      INSERT INTO sec_filings (accession, cik, ticker, form, filed_at, accepted_at, status, created_at, updated_at)
      VALUES ('acc-abc', 'cik-1', 'AAPL', '10-K', '2025-01-01', '2025-01-01', 'complete', '2025-01-01', '2025-01-01')
    `).run();

    db.prepare(`
      INSERT INTO sec_artifacts (accession, sequence, document_name, sha256, type, byte_count, raw_uri, parser_version, created_at)
      VALUES ('acc-abc', 1, 'main.html', 'sha-hash', 'html', 1000, 'https://sec.gov', 'v2', '2025-01-01')
    `).run();

    db.prepare(`
      INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
      VALUES ('acc-abc', '10-K', 'AAPL', '2025-01-01', 1)
    `).run();

    db.prepare(`
      INSERT INTO document_chunks (content_hash, chunk_id, symbol, source, created_at)
      VALUES ('hash-123', 'AAPL:acc-abc:10-K#c001', 'AAPL', 'sec-edgar', '2025-01-01')
    `).run();

    db.prepare(`
      INSERT INTO chunk_occurrences (vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at, created_at)
      VALUES ('vec-123', 'hash-123', 'AAPL', 'sec-edgar', 'acc-abc', 'body', 1, '2025-01-01', '2025-01-01')
    `).run();

    // Verify they exist
    const initialFiling = db.prepare("SELECT status FROM sec_filings WHERE accession = 'acc-abc'").get() as { status: string };
    expect(initialFiling.status).toBe("complete");

    // Perform cache clear for accession 'acc-abc'
    const acns = ["acc-abc"];
    const BATCH_SIZE = 50;

    for (let i = 0; i < acns.length; i += BATCH_SIZE) {
      const batch = acns.slice(i, i + BATCH_SIZE);
      const ph = batch.map(() => "?").join(",");

      // 1. Delete from ingested_accessions
      db.prepare(`DELETE FROM ingested_accessions WHERE accession IN (${ph})`).run(...batch);

      // 2. Delete from document_chunks using chunk_id prefix check
      const chunkQueries = batch.map(() => "chunk_id LIKE '%:' || ? || ':%'").join(" OR ");
      db.prepare(`
        DELETE FROM document_chunks WHERE content_hash IN (
          SELECT content_hash FROM document_chunks WHERE (${chunkQueries}) AND source = 'sec-edgar'
        )
      `).run(...batch);

      // 3. Delete from chunk_occurrences
      db.prepare(`DELETE FROM chunk_occurrences WHERE accession IN (${ph})`).run(...batch);

      // 4. Update status in sec_filings
      const nowStr = new Date().toISOString();
      db.prepare(`
        UPDATE sec_filings SET status = 'discovered', updated_at = ? WHERE accession IN (${ph})
      `).run(nowStr, ...batch);
    }

    // Verify tables are cleared
    const updatedFiling = db.prepare("SELECT status FROM sec_filings WHERE accession = 'acc-abc'").get() as { status: string };
    expect(updatedFiling.status).toBe("discovered");

    const ingestedCount = db.prepare("SELECT COUNT(*) as count FROM ingested_accessions WHERE accession = 'acc-abc'").get() as { count: number };
    expect(ingestedCount.count).toBe(0);

    const chunkCount = db.prepare("SELECT COUNT(*) as count FROM document_chunks WHERE chunk_id = 'AAPL:acc-abc:10-K#c001'").get() as { count: number };
    expect(chunkCount.count).toBe(0);

    const occurrenceCount = db.prepare("SELECT COUNT(*) as count FROM chunk_occurrences WHERE accession = 'acc-abc'").get() as { count: number };
    expect(occurrenceCount.count).toBe(0);
  });
});

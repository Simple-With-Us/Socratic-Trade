import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyVersionedMigrations, getDb } from "../src/lib/db";
import { insertChunkOccurrences, insertDocumentChunkFts, insertSecFiling } from "../src/lib/db-learning";
import {
  compileCorpusWideLexicalQuery,
  searchCorpusWideLexicalCandidates
} from "../src/lib/rag/corpus-wide-lexical";

const NOW = "2026-07-21T12:00:00.000Z";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-corpus-wide-lexical-${randomUUID()}.db`)}`;
  applyVersionedMigrations(getDb());
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM document_chunks_fts; DELETE FROM chunk_occurrences; DELETE FROM sec_filings;");
});

function seed(input: {
  vectorId: string;
  hash: string;
  symbol?: string;
  source?: string;
  accession: string;
  acceptedAt: string;
  text: string;
  section?: string;
  form?: string;
}): void {
  const symbol = input.symbol ?? "AAPL";
  const source = input.source ?? "sec-edgar";
  insertSecFiling({
    accession: input.accession,
    cik: "0000320193",
    ticker: symbol,
    form: input.form ?? "10-K",
    filedAt: input.acceptedAt || NOW,
    acceptedAt: input.acceptedAt || NOW,
    status: "complete",
    chunkCount: 1
  });
  insertChunkOccurrences([{
    vectorId: input.vectorId,
    contentHash: input.hash,
    symbol,
    source,
    accession: input.accession,
    section: input.section ?? "Item 1.01",
    ordinal: 1,
    acceptedAt: input.acceptedAt,
    createdAt: NOW
  }]);
  insertDocumentChunkFts(input.hash, symbol, source, input.accession, input.text);
}

describe("compileCorpusWideLexicalQuery", () => {
  it("quotes terms so FTS operators cannot alter the search grammar", () => {
    expect(compileCorpusWideLexicalQuery('" OR NEAR/10 * (revenue)')).toBe('"OR" OR "NEAR/10" OR "revenue"');
    expect(compileCorpusWideLexicalQuery("Dividend dividend DIVIDEND")).toBe('"Dividend"');
    expect(compileCorpusWideLexicalQuery("---***()")).toBeNull();
    expect(compileCorpusWideLexicalQuery("x".repeat(8_193))).toBeNull();
  });
});

describe("searchCorpusWideLexicalCandidates", () => {
  it("finds exact filing terms and accession tokens with stable provenance", () => {
    seed({
      vectorId: "vec-accession",
      hash: "hash-accession",
      accession: "0000320193-25-000090",
      acceptedAt: "2025-11-01T18:00:00.000Z",
      text: "Item 1.01. Accession 0000320193-25-000090 records a material agreement."
    });
    seed({
      vectorId: "vec-other-symbol",
      hash: "hash-other-symbol",
      symbol: "MSFT",
      accession: "0000789019-25-000010",
      acceptedAt: "2025-11-01T18:00:00.000Z",
      text: "Item 1.01. Accession 0000320193-25-000090 appears in an unrelated comparison."
    });

    const rows = searchCorpusWideLexicalCandidates({
      symbol: "aapl",
      query: "0000320193-25-000090 Item 1.01"
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "vec-accession",
      score: 0,
      source: "sec-edgar",
      symbol: "AAPL",
      accession: "0000320193-25-000090",
      doc_type: "10-k",
      section: "Item 1.01",
      retrievalSources: ["lexical"]
    });
    expect(rows[0]!.metadata).toMatchObject({
      content_hash: "hash-accession",
      accepted_at: "2025-11-01T18:00:00.000Z",
      retrieval_sources: ["lexical"],
      availability: "accepted_at"
    });
  });

  it("fails closed for empty, punctuation-only, and injection-like queries", () => {
    seed({
      vectorId: "vec-safe",
      hash: "hash-safe",
      accession: "0000320193-25-000091",
      acceptedAt: "2025-11-01T18:00:00.000Z",
      text: "Revenue growth remained durable."
    });

    expect(searchCorpusWideLexicalCandidates({ symbol: "AAPL", query: "---***()" })).toEqual([]);
    expect(searchCorpusWideLexicalCandidates({ symbol: "AAPL", query: '" OR * NEAR/10' })).toEqual([]);
    expect(searchCorpusWideLexicalCandidates({ symbol: "***", query: "revenue" })).toEqual([]);
  });

  it("recalls a filing that matches only the discriminative subset of a natural-language question", () => {
    seed({
      vectorId: "vec-dividend-policy",
      hash: "hash-dividend-policy",
      accession: "0000320193-25-000096",
      acceptedAt: "2025-11-01T18:00:00.000Z",
      text: "The board declared a quarterly cash dividend and reaffirmed its capital return policy."
    });

    const rows = searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "How did management's capital allocation and quarterly dividend policy evolve amid demand softness?"
    });

    expect(rows.map((row) => row.id)).toContain("vec-dividend-policy");
  });

  it("uses occurrence accepted_at for PIT and makes strict-undated explicit", () => {
    seed({
      vectorId: "vec-old",
      hash: "hash-old",
      accession: "0000320193-25-000092",
      acceptedAt: "2025-05-01T12:00:00.000Z",
      text: "Revenue guidance was raised."
    });
    seed({
      vectorId: "vec-future",
      hash: "hash-future",
      accession: "0000320193-26-000001",
      acceptedAt: "2026-05-01T12:00:00.000Z",
      text: "Revenue guidance was raised after the cutoff."
    });
    seed({
      vectorId: "vec-undated",
      hash: "hash-undated",
      accession: "0000320193-25-000093",
      acceptedAt: "",
      text: "Revenue guidance has an unknown availability date."
    });

    const strict = searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "revenue guidance",
      asOf: "2025-12-31T23:59:59.000Z"
    });
    expect(strict.map((row) => row.id)).toEqual(["vec-old"]);

    const lenient = searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "revenue guidance",
      asOf: "2025-12-31T23:59:59.000Z",
      strictUndated: false
    });
    expect(lenient.map((row) => row.id).sort()).toEqual(["vec-old", "vec-undated"]);
    expect(lenient.find((row) => row.id === "vec-undated")?.metadata.availability).toBe("undated");
    expect(searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "revenue guidance",
      asOf: "not-a-date"
    })).toEqual([]);
  });

  it("deduplicates a repeated FTS occurrence and preserves deterministic BM25 order", () => {
    seed({
      vectorId: "vec-weak",
      hash: "hash-weak",
      accession: "0000320193-25-000094",
      acceptedAt: "2025-10-01T12:00:00.000Z",
      text: "The company mentioned dividends once among unrelated disclosures."
    });
    seed({
      vectorId: "vec-strong",
      hash: "hash-strong",
      accession: "0000320193-25-000095",
      acceptedAt: "2025-10-02T12:00:00.000Z",
      text: "Dividends dividends dividends: quarterly dividends declared and dividends paid."
    });
    // FTS5 has no uniqueness constraint. Simulate a legacy duplicate and make the adapter prove
    // that its returned occurrence list remains unique and stable.
    getDb().prepare(`
      INSERT INTO document_chunks_fts (content_hash, symbol, source, accession, text)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "hash-strong", "AAPL", "sec-edgar", "0000320193-25-000095",
      "Dividends dividends dividends: quarterly dividends declared and dividends paid."
    );

    const rows = searchCorpusWideLexicalCandidates({ symbol: "AAPL", query: "dividends", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["vec-strong", "vec-weak"]);
    expect(rows[0]!.lexicalScore).toBeLessThan(rows[1]!.lexicalScore);
  });
});

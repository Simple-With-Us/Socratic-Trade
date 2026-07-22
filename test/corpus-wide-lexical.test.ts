import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyVersionedMigrations,
  beginVectorCommit,
  getDb,
  insertManagedChunkOccurrences,
  markVectorCommitCommitted,
  markVectorCommitReceiptsPersisted
} from "../src/lib/db";
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
  db.exec(`
    DELETE FROM document_chunks_fts;
    DELETE FROM vector_document_heads;
    DELETE FROM vector_document_versions;
    DELETE FROM chunk_occurrences;
    DELETE FROM vector_ingest_commits;
    DELETE FROM sec_filings;
  `);
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

function seedManaged(input: {
  commitId: string;
  vectorId: string;
  hash: string;
  accession: string;
  contentVersion: string;
  acceptedAt: string;
  committedAt: string;
  text: string;
  tenantScope?: string;
  userId?: string;
  source?: string;
}): void {
  const attemptToken = `attempt-${input.commitId}`;
  const tenantScope = input.tenantScope ?? "shared:operator";
  const userId = input.userId ?? "local";
  const source = input.source ?? "sec-edgar";
  insertSecFiling({
    accession: input.accession,
    cik: "0000320193",
    ticker: "AAPL",
    form: "10-K",
    filedAt: input.acceptedAt,
    acceptedAt: input.acceptedAt,
    status: "complete",
    chunkCount: 1
  });
  expect(beginVectorCommit({
    id: input.commitId,
    tenantScope,
    userId,
    source,
    accession: input.accession,
    documentKey: input.accession,
    contentVersion: input.contentVersion,
    retrievalMetadataVersion: "metadata-v1",
    parserRevision: "parser-v1",
    embedRevision: "embed-v1",
    expectedVectors: 1,
    attemptToken,
    leaseExpiresAt: "2027-01-01T00:00:00.000Z",
    now: input.committedAt
  })).toBe("started");
  insertManagedChunkOccurrences([{
    vectorId: input.vectorId,
    contentHash: input.hash,
    symbol: "AAPL",
    source,
    accession: input.accession,
    section: "Item 1.01",
    ordinal: 1,
    acceptedAt: input.acceptedAt,
    tenantScope,
    contentVersion: input.contentVersion,
    commitId: input.commitId,
    receiptState: "pending",
    createdAt: input.committedAt
  }]);
  insertDocumentChunkFts(input.hash, "AAPL", source, input.accession, input.text);
  markVectorCommitReceiptsPersisted(input.commitId, attemptToken, input.committedAt);
  markVectorCommitCommitted(input.commitId, attemptToken, input.committedAt);
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

  it("applies metadata filters before the lexical cap and searches filing text only", () => {
    seed({
      vectorId: "vec-filtered-10k",
      hash: "hash-filtered-10k",
      accession: "0000320193-25-000098",
      acceptedAt: "2025-11-01T18:00:00.000Z",
      text: "Revenue guidance from the annual filing."
    });
    seed({
      vectorId: "vec-filtered-10q",
      hash: "hash-filtered-10q",
      accession: "0000320193-25-000099",
      acceptedAt: "2025-11-01T18:00:00.000Z",
      form: "10-Q",
      section: "Management Discussion",
      text: "Revenue guidance from the quarterly filing."
    });

    const filtered = searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "revenue guidance",
      limit: 1,
      docTypes: ["10-q"],
      section: "Management Discussion"
    });
    expect(filtered.map((row) => row.id)).toEqual(["vec-filtered-10q"]);
    expect(searchCorpusWideLexicalCandidates({ symbol: "AAPL", query: "AAPL" })).toEqual([]);
  });

  it("classifies sec-8k FTS rows without requiring a sec_filings row", () => {
    seed({
      vectorId: "vec-8k-body",
      hash: "hash-8k-body",
      source: "sec-8k",
      accession: "0000320193-26-000008",
      acceptedAt: "2026-02-01T12:00:00.000Z",
      text: "The company entered a material agreement."
    });
    // Full-body 8-K ingestion owns the occurrence/FTS row but does not synthesize sec_filings.
    getDb().prepare("DELETE FROM sec_filings WHERE accession = ?").run("0000320193-26-000008");

    const rows = searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "material agreement",
      docTypes: ["8-k"]
    });
    expect(rows.map((row) => row.id)).toEqual(["vec-8k-body"]);
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

  it("never recalls a pending managed occurrence before its provider receipt commits", () => {
    seed({
      vectorId: "vec-pending",
      hash: "hash-pending",
      accession: "0000320193-25-000097",
      acceptedAt: "2025-10-03T12:00:00.000Z",
      text: "Pending covenant evidence must remain invisible."
    });
    getDb().prepare("UPDATE chunk_occurrences SET receipt_state = 'pending' WHERE vector_id = ?")
      .run("vec-pending");

    expect(searchCorpusWideLexicalCandidates({ symbol: "AAPL", query: "covenant evidence" })).toEqual([]);
  });

  it("only recalls visible shared filing occurrences, never another user's private or transcript source", () => {
    seedManaged({
      commitId: "commit-shared-visible",
      vectorId: "vec-shared-visible",
      hash: "hash-shared-visible",
      accession: "0000320193-25-000199",
      contentVersion: "shared-visible-v1",
      acceptedAt: "2025-10-03T12:00:00.000Z",
      committedAt: "2025-10-03T13:00:00.000Z",
      text: "Visibility boundary evidence belongs to the shared filing corpus."
    });
    seedManaged({
      commitId: "commit-private-other-user",
      vectorId: "vec-private-other-user",
      hash: "hash-private-other-user",
      accession: "0000320193-25-000200",
      contentVersion: "private-v1",
      acceptedAt: "2025-10-03T12:00:00.000Z",
      committedAt: "2025-10-03T13:00:00.000Z",
      text: "Visibility boundary evidence must not cross user tenants.",
      tenantScope: "private:other-user",
      userId: "other-user"
    });
    seedManaged({
      commitId: "commit-transcript-source",
      vectorId: "vec-transcript-source",
      hash: "hash-transcript-source",
      accession: "0000320193-25-000201",
      contentVersion: "transcript-v1",
      acceptedAt: "2025-10-03T12:00:00.000Z",
      committedAt: "2025-10-03T13:00:00.000Z",
      text: "Visibility boundary evidence from a licensed transcript must not enter filing FTS.",
      source: "fmp-earnings-transcript"
    });

    const rows = searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "visibility boundary evidence",
      visibleTenantScopes: ["shared:operator"]
    });

    expect(rows.map((row) => row.id)).toEqual(["vec-shared-visible"]);
    expect(rows[0]!.metadata).toMatchObject({ tenant_scope: "shared:operator", scope: "shared" });
  });

  it("hides a legacy occurrence when a visible current managed head shadows the same filing", () => {
    seed({
      vectorId: "vec-legacy-shadowed",
      hash: "hash-legacy-shadowed",
      accession: "0000320193-25-000202",
      acceptedAt: "2025-10-03T12:00:00.000Z",
      text: "Shadowed covenant evidence from the legacy filing text."
    });
    seedManaged({
      commitId: "commit-current-shadows-legacy",
      vectorId: "vec-current-managed",
      hash: "hash-current-managed",
      accession: "0000320193-25-000202",
      contentVersion: "current-v1",
      acceptedAt: "2025-10-03T12:00:00.000Z",
      committedAt: "2025-10-03T13:00:00.000Z",
      text: "Current covenant evidence supersedes the legacy filing text."
    });

    expect(searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "covenant evidence",
      visibleTenantScopes: ["shared:operator"]
    }).map((row) => row.id)).toEqual(["vec-current-managed"]);
  });

  it("uses the active managed head now and the historically active version for PIT", () => {
    seedManaged({
      commitId: "commit-old",
      vectorId: "vec-old-version",
      hash: "hash-old-version",
      accession: "0000320193-25-000098",
      contentVersion: "version-old",
      acceptedAt: "2025-05-01T12:00:00.000Z",
      committedAt: "2025-05-01T13:00:00.000Z",
      text: "Covenant evidence from the original filing generation."
    });
    seedManaged({
      commitId: "commit-new",
      vectorId: "vec-new-version",
      hash: "hash-new-version",
      accession: "0000320193-25-000098",
      contentVersion: "version-new",
      acceptedAt: "2025-06-01T12:00:00.000Z",
      committedAt: "2025-06-01T13:00:00.000Z",
      text: "Covenant evidence from the corrected filing generation."
    });

    expect(searchCorpusWideLexicalCandidates({ symbol: "AAPL", query: "covenant evidence" })
      .map((row) => row.id)).toEqual(["vec-new-version"]);
    expect(searchCorpusWideLexicalCandidates({
      symbol: "AAPL",
      query: "covenant evidence",
      asOf: "2025-05-15T00:00:00.000Z"
    }).map((row) => row.id)).toEqual(["vec-old-version"]);
  });
});

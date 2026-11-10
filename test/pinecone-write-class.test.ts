import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyVersionedMigrations,
  getDb
} from "../src/lib/db";
import { processedCommitCoversAccession } from "../src/lib/rag/corpus-reembed";
import { insertChunkOccurrences, insertDocumentChunkFts, insertSecFiling } from "../src/lib/db-learning";
import { chunkDocument, type ChunkInput } from "../src/lib/rag/chunk";
import { searchCorpusWideLexicalCandidates } from "../src/lib/rag/corpus-wide-lexical";
import { persistLocalComplete } from "../src/lib/rag/persist-local-complete";
import {
  parseItemCodeFromSection,
  pineconeWriteClass,
  sectionDocumentKey,
  selectSignalChunks
} from "../src/lib/rag/pinecone-write-class";
import { buildSignalSectionDocuments } from "../src/lib/rag/processed-corpus-write";
import { roleOfSpeaker } from "../src/lib/web-sources/roic-transcripts";

const NOW = "2026-08-18T12:00:00.000Z";
const ACCESSION = "0001045810-26-000123";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pinecone-write-class-${randomUUID()}.db`)}`;
  applyVersionedMigrations(getDb());
});

beforeEach(() => {
  delete process.env.RAG_PINECONE_WRITE_CLASS;
  const db = getDb();
  db.exec(`
    DELETE FROM document_chunks_fts_index;
    DELETE FROM document_chunks_fts;
    DELETE FROM chunk_occurrences;
    DELETE FROM ingested_accessions;
    DELETE FROM sec_filings;
    DELETE FROM vector_document_heads;
    DELETE FROM vector_document_versions;
    DELETE FROM vector_ingest_commits;
  `);
});

function tenKFixture(): ChunkInput {
  return {
    text: "fallback",
    ticker: "NVDA",
    title: "NVDA 10-K",
    doc_type: "10-k",
    source: "sec-edgar",
    published_at: "2026-02-26",
    sections: [
      { itemCode: "1", itemTitle: "Business", text: "We design GPUs for data centers and gaming worldwide. ".repeat(12) },
      { itemCode: "1A", itemTitle: "Risk Factors", text: "A going-concern change and export-control risk could reduce data-center demand. ".repeat(12) },
      { itemCode: "7", itemTitle: "Management's Discussion and Analysis", text: "Revenue grew and we raised full-year guidance on data-center demand. ".repeat(12) },
      { itemCode: "7A", itemTitle: "Quantitative and Qualitative Disclosures About Market Risk", text: "Interest-rate and FX sensitivity remain material to earnings. ".repeat(8) },
      { itemCode: "8", itemTitle: "Financial Statements and Supplementary Data", text: "| Cash | 2025 | 2024 |\n| --- | --- | --- |\n| 1 | 2 | 3 |" },
      { itemCode: "15", itemTitle: "Exhibits and Financial Statement Schedules", text: "Exhibit 31.1 Certification of Chief Executive Officer. ".repeat(8) }
    ]
  };
}

function roicSpeakerSections(): Array<{ itemCode: string; itemTitle: string; text: string }> {
  const turns = [
    { speaker: "Operator", text: "Welcome to the call. Please stand by. ".repeat(4) },
    { speaker: "CEO", text: "Demand was stronger than we expected and we are raising guidance. ".repeat(6) },
    { speaker: "CFO", text: "Gross margin expanded on mix and we bought back stock. ".repeat(6) },
    ...Array.from({ length: 12 }, (_, i) => ({
      speaker: "Analyst",
      text: `Question ${i + 1} about capex, inventory, and the data-center outlook for next year. `.repeat(3)
    }))
  ];
  return turns.map((turn) => ({
    itemCode: roleOfSpeaker(turn.speaker),
    itemTitle: turn.speaker,
    text: turn.text
  }));
}

describe("pineconeWriteClass", () => {
  it("defaults to full-body and does not silently flip", () => {
    expect(pineconeWriteClass({})).toBe("full-body");
    expect(pineconeWriteClass({ RAG_PINECONE_WRITE_CLASS: "full-body" })).toBe("full-body");
    expect(pineconeWriteClass({ RAG_PINECONE_WRITE_CLASS: "highlight+signal" })).toBe("highlight+signal");
    expect(pineconeWriteClass({ RAG_PINECONE_WRITE_CLASS: "highlight-only" })).toBe("highlight-only");
  });
});

describe("selectSignalChunks", () => {
  it("parses itemCode from real chunkDocument 10-K sections and skips Item 8", () => {
    const chunks = chunkDocument(tenKFixture(), {});
    expect(chunks.some((c) => parseItemCodeFromSection(c.section) === "1A")).toBe(true);
    expect(chunks.some((c) => parseItemCodeFromSection(c.section) === "7")).toBe(true);
    const signal = selectSignalChunks(chunks, "10-K");
    const codes = new Set(signal.map((c) => parseItemCodeFromSection(c.section)));
    expect(codes.has("1A")).toBe(true);
    expect(codes.has("7")).toBe(true);
    expect(codes.has("7A")).toBe(true);
    expect(codes.has("8")).toBe(false);
    expect(codes.has("15")).toBe(false);
    expect(codes.has("1")).toBe(false);
    expect(signal.length).toBeGreaterThan(0);
    expect(signal.length).toBeLessThanOrEqual(12);
  });

  it("is form-aware: 10-Q Item 2 is MD&A, not 10-K properties", () => {
    const chunks = chunkDocument({
      text: "fallback",
      ticker: "IBM",
      title: "IBM 10-Q",
      doc_type: "10-q",
      source: "sec-edgar",
      published_at: "2026-04-30",
      sections: [
        { itemCode: "1", itemTitle: "Financial Statements", text: "Condensed consolidated statements. ".repeat(10) },
        { itemCode: "2", itemTitle: "Management's Discussion and Analysis", text: "Quarterly revenue and outlook changed. ".repeat(10) },
        { itemCode: "1A", itemTitle: "Risk Factors", text: "No material changes except liquidity. ".repeat(8) }
      ]
    }, {});
    const signal = selectSignalChunks(chunks, "10-Q");
    const codes = new Set(signal.map((c) => parseItemCodeFromSection(c.section)));
    expect(codes.has("2")).toBe(true);
    expect(codes.has("1A")).toBe(true);
    expect(codes.has("1")).toBe(false);
  });

  it("keeps ROIC management turns plus the first N qa/analyst turns, never prepared", () => {
    const chunks = chunkDocument({
      text: "fallback",
      ticker: "AAPL",
      title: "AAPL earnings",
      doc_type: "earnings-transcript",
      source: "roic",
      published_at: "2026-05-01",
      sections: roicSpeakerSections()
    }, {});
    const signal = selectSignalChunks(chunks, "earnings-transcript");
    const codes = signal.map((c) => parseItemCodeFromSection(c.section).toLowerCase());
    expect(codes.includes("management")).toBe(true);
    expect(codes.includes("operator")).toBe(false);
    expect(codes.includes("prepared")).toBe(false);
    expect(codes.filter((c) => c === "analyst" || c === "qa").length).toBeLessThanOrEqual(8);
  });
});

describe("persistLocalComplete + section key", () => {
  it("writes bare-accession FTS that joins a section occurrence", async () => {
    const chunks = chunkDocument(tenKFixture(), {});
    const signal = selectSignalChunks(chunks, "10-K");
    const picked = signal[0]!;
    await persistLocalComplete({
      ticker: "NVDA",
      accession: ACCESSION,
      docType: "10-K",
      chunks,
      pineconeWriteClass: "highlight+signal"
    });
    const documentKey = sectionDocumentKey({
      ticker: "NVDA",
      accession: ACCESSION,
      form: "10-K",
      itemCode: parseItemCodeFromSection(picked.section)
    });
    expect(documentKey).toContain(ACCESSION);
    expect(documentKey).toContain(":section:");
    insertSecFiling({
      accession: ACCESSION,
      cik: "0001045810",
      ticker: "NVDA",
      form: "10-K",
      filedAt: NOW,
      acceptedAt: NOW,
      status: "complete",
      chunkCount: chunks.length
    });
    insertChunkOccurrences([{
      vectorId: "vec-section-1a",
      contentHash: picked.content_hash,
      symbol: "NVDA",
      source: "sec-edgar",
      accession: documentKey,
      section: picked.section,
      ordinal: 1,
      acceptedAt: NOW,
      createdAt: NOW
    }]);
    insertDocumentChunkFts(picked.content_hash, "NVDA", "sec-edgar", ACCESSION, picked.text);
    const hits = searchCorpusWideLexicalCandidates({
      symbol: "NVDA",
      query: "going-concern export-control guidance",
      asOf: NOW,
      strictUndated: true,
      source: "sec-edgar"
    });
    expect(hits.some((hit) => hit.id === "vec-section-1a")).toBe(true);
  });

  it("builds section storeDocuments that contain the bare accession", () => {
    const chunks = chunkDocument(tenKFixture(), {});
    const docs = buildSignalSectionDocuments({
      ticker: "NVDA",
      accession: ACCESSION,
      form: "10-K",
      publishedAt: NOW,
      chunks
    });
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc.documentKey).toContain(ACCESSION);
      expect(doc.documentKey).toContain(":section:");
    }
  });

  it("treats a highlight+signal commit as accession coverage for re-embed", () => {
    const documentKey = sectionDocumentKey({
      ticker: "NVDA",
      accession: ACCESSION,
      form: "10-K",
      itemCode: "1A"
    });
    getDb().prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key,
        content_version, retrieval_metadata_version, parser_revision, embed_revision,
        expected_vectors, vector_namespace, state, created_at, updated_at, committed_at
      ) VALUES (?, 'shared:operator', 'local', 'sec-edgar', ?, ?, 'v1', 'metadata-v1',
        'sec-signal-section-v1', 'embed-test', 1, 'managed', 'committed', ?, ?, ?)
    `).run("commit-signal-1", ACCESSION, documentKey, NOW, NOW, NOW);
    expect(processedCommitCoversAccession("NVDA", ACCESSION, "embed-test")).toBe(true);
    expect(processedCommitCoversAccession("NVDA", "0000000000-00-000000", "embed-test")).toBe(false);
  });
});

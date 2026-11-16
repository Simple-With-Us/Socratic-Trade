import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyVersionedMigrations, getDb } from "../src/lib/db";
import { insertDocumentAbstract } from "../src/lib/db-document-abstracts";
import { secArtifactWritePath, writeCorpusFileSync } from "../src/lib/rag/corpus-layout";
import {
  assembleProposerDossier,
  HYDRATE_ATTACH_CHARS,
  proposerDossierEnabled,
  SCOUT_STUB_CHARS
} from "../src/lib/rag/proposer-dossier";
import type { RetrievedChunk } from "../src/lib/vector-db";

const ACCESSION = "0000320193-24-000106";

describe("assembleProposerDossier", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dossier-${randomUUID()}.db`)}`;
    applyVersionedMigrations(getDb());
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM document_abstracts").run();
    delete process.env.RAG_PROPOSER_DOSSIER;
  });

  it("defaults ON and treats off/0 as the raw retrieve path flag", () => {
    expect(proposerDossierEnabled({})).toBe(true);
    expect(proposerDossierEnabled({ RAG_PROPOSER_DOSSIER: "off" })).toBe(false);
    expect(proposerDossierEnabled({ RAG_PROPOSER_DOSSIER: "0" })).toBe(false);
    expect(proposerDossierEnabled({ RAG_PROPOSER_DOSSIER: "on" })).toBe(true);
  });

  it("scout stub is <=1200 chars and suppresses a twin document-summary", async () => {
    const longSummary = "Apple 10-K highlight. ".repeat(80);
    expect(longSummary.length).toBeGreaterThan(SCOUT_STUB_CHARS);
    insertDocumentAbstract({
      id: `abstract:10k-delta:AAPL:${ACCESSION}`,
      sourceType: "10k-delta",
      ticker: "AAPL",
      accessionOrEventId: ACCESSION,
      headline: "AAPL 10-K highlights",
      summaryText: longSummary,
      sourceChunkIds: ["abc"],
      createdAt: "2026-08-22T00:00:00.000Z",
      modelUsed: "extractive-highlights-v2"
    });

    const twin: RetrievedChunk = {
      id: "vec-summary",
      text: "compact vector twin of the same 10-K abstract",
      score: 0.9,
      doc_type: "document-summary",
      metadata: { accession: ACCESSION }
    };
    const body: RetrievedChunk = {
      id: "vec-body",
      text: "Item 8 tables should not steal the scout slot",
      score: 0.8,
      doc_type: "10-k",
      section: "8. Financial Statements",
      metadata: { accession: ACCESSION }
    };

    const dossier = await assembleProposerDossier({
      symbol: "AAPL",
      depth: "scout",
      query: "Significant financial events, SEC filings, and macro catalysts for $AAPL",
      limit: 1,
      retrieve: async () => [twin, body]
    });

    expect(dossier.abstracts).toHaveLength(1);
    expect(dossier.abstracts[0]!.summaryText.length).toBeLessThanOrEqual(SCOUT_STUB_CHARS);
    expect(dossier.chunks).toHaveLength(1);
    expect(dossier.chunks[0]!.text).toBe(dossier.abstracts[0]!.summaryText);
    expect(dossier.chunks.some((chunk) => chunk.id === "vec-summary")).toBe(false);
    expect(dossier.chunks.some((chunk) => chunk.doc_type === "document-summary" && chunk.id === "vec-summary")).toBe(
      false
    );
  });

  it("deep inlines latest-per-type abstracts and keeps a non-twin section chunk", async () => {
    insertDocumentAbstract({
      id: `abstract:10k-delta:AAPL:${ACCESSION}`,
      sourceType: "10k-delta",
      ticker: "AAPL",
      accessionOrEventId: ACCESSION,
      headline: "AAPL 10-K",
      summaryText: "Risk factors include supply-chain concentration and regulatory export controls.",
      sourceChunkIds: [],
      createdAt: "2026-08-22T00:00:00.000Z",
      modelUsed: "extractive-highlights-v2"
    });
    insertDocumentAbstract({
      id: "abstract:8k-brief:AAPL:0000320193-24-000200",
      sourceType: "8k-brief",
      ticker: "AAPL",
      accessionOrEventId: "0000320193-24-000200",
      headline: "AAPL 8-K",
      summaryText: "Item 2.02 results: revenue beat and a buyback authorization.",
      sourceChunkIds: [],
      createdAt: "2026-08-21T00:00:00.000Z",
      modelUsed: "extractive-highlights-v2"
    });

    const dossier = await assembleProposerDossier({
      symbol: "AAPL",
      depth: "deep",
      query: "catalysts",
      limit: 8,
      retrieve: async () => [
        {
          id: "sum",
          text: "duplicate 10-K summary vector",
          score: 0.95,
          doc_type: "document-summary",
          metadata: { accession: ACCESSION }
        },
        {
          id: "sec-7",
          text: "MD&A: iPhone units and Services growth.",
          score: 0.8,
          doc_type: "10-k",
          section: "7. Management's Discussion and Analysis",
          metadata: { accession: ACCESSION }
        }
      ]
    });

    expect(dossier.abstracts.map((row) => row.sourceType).sort()).toEqual(["10k-delta", "8k-brief"]);
    expect(dossier.chunks.some((chunk) => chunk.id === "sum")).toBe(false);
    expect(dossier.chunks.some((chunk) => chunk.id === "sec-7")).toBe(true);
    expect(dossier.coverage.want).toContain("10-k");
    expect(dossier.coverage.have).toContain("10-k");
    expect(dossier.coverage.have).toContain("8-k");
  });

  it("caps hydrated 1A text so one filing cannot eat the 24k hose", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dossier-hydrate-"));
    const previousDataDir = process.env.DATA_DIR;
    const previousCorpusDir = process.env.CORPUS_DIR;
    process.env.DATA_DIR = dataDir;
    delete process.env.CORPUS_DIR;
    try {
      const huge = "Item 1A. Risk. Export controls and going-concern language. ".repeat(200);
      expect(huge.length).toBeGreaterThan(HYDRATE_ATTACH_CHARS);
      writeCorpusFileSync(
        secArtifactWritePath("0000320193", ACCESSION, 1, "chunks.json"),
        JSON.stringify([
          {
            text: huge,
            parent_text: huge,
            itemCode: "1A",
            section: "1A. Risk Factors"
          }
        ])
      );
      const dossier = await assembleProposerDossier({
        symbol: "AAPL",
        depth: "deep",
        query: "catalysts",
        limit: 8,
        retrieve: async () => [
          {
            id: "sec-1a",
            text: "short 1A vector",
            score: 0.9,
            doc_type: "10-k",
            section: "1A. Risk Factors",
            metadata: { accession: ACCESSION }
          }
        ]
      });
      const attached = dossier.chunks.find((chunk) => chunk.id === "sec-1a");
      expect(attached?.text.length).toBeLessThanOrEqual(HYDRATE_ATTACH_CHARS);
      expect(attached?.text.length ?? 0).toBeGreaterThan("short 1A vector".length);
      expect(attached?.text).toContain("Export controls");
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      if (previousCorpusDir === undefined) delete process.env.CORPUS_DIR;
      else process.env.CORPUS_DIR = previousCorpusDir;
    }
  });

  it("keeps hydrated 1A when Item 7 also reserves a slot at the default deep limit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dossier-1a-keep-"));
    const previousDataDir = process.env.DATA_DIR;
    const previousCorpusDir = process.env.CORPUS_DIR;
    process.env.DATA_DIR = dataDir;
    delete process.env.CORPUS_DIR;
    try {
      insertDocumentAbstract({
        id: `abstract:10k-delta:AAPL:${ACCESSION}`,
        sourceType: "10k-delta",
        ticker: "AAPL",
        accessionOrEventId: ACCESSION,
        headline: "AAPL 10-K",
        summaryText: "Abstract only.  Neither 1A nor MD&A is in the retrieved pack.",
        sourceChunkIds: [],
        createdAt: "2026-08-22T00:00:00.000Z",
        modelUsed: "extractive-highlights-v2"
      });
      writeCorpusFileSync(
        secArtifactWritePath("0000320193", ACCESSION, 1, "chunks.json"),
        JSON.stringify([
          {
            text: "Item 1A. Risk factors include export controls and customer concentration.",
            parent_text: "Item 1A. Risk factors include export controls and customer concentration.",
            itemCode: "1A",
            section: "1A. Risk Factors"
          },
          {
            text: "Item 7. MD&A discusses iPhone units and Services growth in detail across regions.",
            parent_text: "Item 7. MD&A discusses iPhone units and Services growth in detail across regions.",
            itemCode: "7",
            section: "7. Management's Discussion and Analysis"
          }
        ])
      );
      const fillers: RetrievedChunk[] = Array.from({ length: 8 }, (_, index) => ({
        id: `vec-item8-${index}`,
        text: `Item 8 note ${index}: tables and footnotes, not risk factors.`,
        score: 0.8 - index * 0.01,
        doc_type: "10-k",
        section: "8. Financial Statements",
        metadata: { accession: `${ACCESSION}-item8-${index}` }
      }));

      const dossier = await assembleProposerDossier({
        symbol: "AAPL",
        depth: "deep",
        query: "catalysts",
        limit: 8,
        retrieve: async () => fillers
      });

      expect(dossier.chunks.some((chunk) => chunk.id === "hydrate:1A:" + ACCESSION)).toBe(true);
      expect(dossier.chunks.some((chunk) => chunk.id === "hydrate:7:" + ACCESSION)).toBe(true);
      expect(dossier.chunks.some((chunk) => /export controls/i.test(chunk.text))).toBe(true);
      expect(dossier.chunks.some((chunk) => /iPhone units/i.test(chunk.text))).toBe(true);
      expect(dossier.chunks).toHaveLength(8);
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      if (previousCorpusDir === undefined) delete process.env.CORPUS_DIR;
      else process.env.CORPUS_DIR = previousCorpusDir;
    }
  });
});

/**
 * R13 (2026-07-01 RAG backlog): provenance-complete citations + optional staleness label,
 * wired into orchestrator.buildProductionDeps().searchKnowledge — BACKEND/PAYLOAD ONLY.
 *
 * Verifies the additive doc_type/section keys are always forwarded, and isStale is included
 * ONLY when RAG_CITATION_STALENESS is on (advisory-only, never gates retrieval).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ retrieveContextDetailed: vi.fn() }));

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return { ...actual, managedVectorLedgerAuthority: vi.fn(), retrieveContextDetailed: mocks.retrieveContextDetailed };
});

let orchestrator: typeof import("../src/lib/chat/orchestrator");

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-orch-search-knowledge-${randomUUID()}.db`)}`;
  // One-time import of the orchestrator module graph — it pulls in effectively the whole app
  // (vector-db/Pinecone/Voyage SDKs, data-providers, broker, memory stores): ~15s cold even solo,
  // slower under full-suite CPU contention. Importing it inside a test body charged that cost to
  // the FIRST test's 20s testTimeout — the source of this file's full-suite flake. beforeAll gets
  // its own explicit budget; the tests themselves are millisecond-fast.
  orchestrator = await import("../src/lib/chat/orchestrator");
}, 120_000);

describe("buildProductionDeps().searchKnowledge — R13 provenance payload", () => {
  beforeEach(() => {
    mocks.retrieveContextDetailed.mockReset();
    delete process.env.RAG_CITATION_STALENESS;
  });

  it("returns doc_type/section as additive keys, and NO isStale key when the flag is off", async () => {
    process.env.RAG_CITATION_STALENESS = "off";
    mocks.retrieveContextDetailed.mockResolvedValue([
      {
        id: "AAPL-10K#c001",
        text: "Apple faces supply-chain risk.",
        score: 0.8,
        source: "sec-edgar",
        as_of: "2024-01-15",
        doc_type: "10-k",
        section: "risk_factors",
        url: "https://sec.gov/x"
      }
    ]);
    const deps = orchestrator.buildProductionDeps();

    const results = await deps.searchKnowledge({ query: "supply chain risk", ticker: "AAPL" }, "local");

    expect(results).toHaveLength(1);
    const chunk = results[0]!;
    expect(chunk.chunk_id).toBe("AAPL-10K#c001");
    expect(chunk.doc_type).toBe("10-k");
    expect(chunk.section).toBe("risk_factors");
    expect(chunk.url).toBe("https://sec.gov/x");
    expect("isStale" in chunk).toBe(false); // never present when the flag is off — not even as undefined-valued key noise
  });

  it("uses immutable occurrence coordinates for id-less citation refs", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([
      {
        id: "",
        text: "Repeated boilerplate",
        score: 0.8,
        source: "sec-edgar",
        doc_type: "10-k",
        section: "MD&A",
        metadata: {
          accession: "0001",
          chunk_ordinal: 3,
          content_hash: "same-text"
        }
      },
      {
        id: "",
        text: "Repeated boilerplate",
        score: 0.7,
        source: "sec-edgar",
        doc_type: "10-k",
        section: "Risk Factors",
        metadata: {
          accession: "0001",
          chunk_ordinal: 4,
          content_hash: "same-text"
        }
      }
    ]);
    const deps = orchestrator.buildProductionDeps();
    const results = await deps.searchKnowledge({ query: "boilerplate", ticker: "AAPL", k: 2 }, "local");

    expect(results[0]!.evidence_ref).not.toBe(results[1]!.evidence_ref);
  });

  // 2026-07-04 RAG quick-wins: wire the previously-dormant post-rerank relevance floor + near-dup
  // suppression into this call site — both existed since 2026-07-01 but no caller ever passed them.
  it("passes minRelevanceScore and dedupeSimilarity through to retrieveContextDetailed", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([]);
    const deps = orchestrator.buildProductionDeps();

    await deps.searchKnowledge({ query: "supply chain risk", ticker: "AAPL" }, "local");

    expect(mocks.retrieveContextDetailed).toHaveBeenCalledWith(
      "supply chain risk",
      "AAPL",
      5,
      "local",
      expect.objectContaining({
        asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        minRelevanceScore: expect.any(Number),
        dedupeSimilarity: expect.any(Number)
      })
    );
  });

  it("includes isStale when RAG_CITATION_STALENESS is on, computed from as_of + doc_type", async () => {
    process.env.RAG_CITATION_STALENESS = "on";
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    mocks.retrieveContextDetailed.mockResolvedValue([
      {
        id: "AAPL-8K#c002",
        text: "Apple announced a buyback.",
        score: 0.7,
        source: "sec-8k",
        as_of: oldDate,
        doc_type: "8-k"
      }
    ]);
    const deps = orchestrator.buildProductionDeps();

    const results = await deps.searchKnowledge({ query: "buyback", ticker: "AAPL" }, "local");

    expect(results[0]!.isStale).toBe(true); // an 8-K at 200 days old is past its ~90d horizon
  });

  it("isStale is advisory-only: never present in the payload used by the retrieval scoring path itself", async () => {
    // Sanity: confirm the underlying chunk's `score` (cosine similarity) is untouched by staleness.
    process.env.RAG_CITATION_STALENESS = "on";
    mocks.retrieveContextDetailed.mockResolvedValue([
      { id: "x", text: "t", score: 0.42, source: "s", as_of: new Date().toISOString(), doc_type: "8-k" }
    ]);
    const deps = orchestrator.buildProductionDeps();

    const results = await deps.searchKnowledge({ query: "q", ticker: "AAPL" }, "local");
    expect(results[0]!.score).toBe(0.42);
    expect(results[0]!.isStale).toBe(false); // fresh, not stale
  });

  it("returns [] when no ticker is provided (unchanged existing behavior)", async () => {
    const deps = orchestrator.buildProductionDeps();
    const results = await deps.searchKnowledge({ query: "q" }, "local");
    expect(results).toEqual([]);
    expect(mocks.retrieveContextDetailed).not.toHaveBeenCalled();
  });

  it("forwards a parseable as_of and defaults asOf to now when omitted", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([]);
    const deps = orchestrator.buildProductionDeps();

    await deps.searchKnowledge({ query: "q", ticker: "AAPL", as_of: "2026-05-01T12:00:00.000Z" }, "local");
    expect(mocks.retrieveContextDetailed.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ asOf: "2026-05-01T12:00:00.000Z" })
    );

    mocks.retrieveContextDetailed.mockClear();
    await deps.searchKnowledge({ query: "q", ticker: "AAPL" }, "local");
    const asOf = mocks.retrieveContextDetailed.mock.calls[0]![4].asOf as string;
    expect(Date.parse(asOf)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});

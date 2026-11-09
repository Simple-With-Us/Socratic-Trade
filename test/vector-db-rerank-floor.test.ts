/**
 * Item 2 (2026-07-01 RAG workstream): post-rerank relevance floor integration test.
 *
 * RetrieveOptions.minRelevanceScore is a NEW, default-off/opt-in field: when a caller sets it,
 * retrieveContextDetailed drops chunks whose Voyage cross-encoder relevanceScore (captured from
 * the rerank step, NOT the Pinecone cosine score) is below the floor, applied AFTER reranking.
 * When the option is omitted, behavior must be byte-for-byte unchanged from before this change.
 *
 * Full-mock integration pattern mirrors test/vector-db.test.ts / test/vector-db-hybrid.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const index = vi.fn(() => ({ query, upsert: vi.fn() }));
  return {
    query,
    index,
    listIndexes: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    resolveApiKey: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return { listIndexes: mocks.listIndexes, createIndex: vi.fn(), Index: mocks.index };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed, rerank: mocks.rerank };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "on";
  delete process.env.HYBRID_RETRIEVAL;
  delete process.env.VECTOR_MIN_SCORE;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
});

const poolMatches = [
  { id: "high", score: 0.6, metadata: { text: "high relevance chunk", userId: "local", scope: "shared" } },
  { id: "mid", score: 0.55, metadata: { text: "mid relevance chunk", userId: "local", scope: "shared" } },
  { id: "low", score: 0.5, metadata: { text: "low relevance chunk", userId: "local", scope: "shared" } },
  { id: "unscored", score: 0.45, metadata: { text: "unscored chunk", userId: "local", scope: "shared" } }
];

describe("retrieveContextDetailed: post-rerank minRelevanceScore floor (opt-in)", () => {
  it("drops chunks below the floor AFTER reranking when minRelevanceScore is set", async () => {
    mocks.query.mockResolvedValue({ matches: poolMatches });
    // limit=3 with a 4-candidate pool so rerank actually engages (rerankMatches only runs when the
    // candidate pool exceeds the requested limit); topK ends up 3, so rerank returns its top 3.
    mocks.rerank.mockResolvedValue({
      data: [
        { index: 0, relevanceScore: 0.9 }, // "high"
        { index: 1, relevanceScore: 0.6 }, // "mid"
        { index: 2, relevanceScore: 0.2 } // "low" — below a 0.5 floor
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", { minRelevanceScore: 0.5 });

    expect(chunks.map((c) => c.id)).toEqual(["high", "mid"]);
    expect(chunks[0]!.relevanceScore).toBe(0.9);
    expect(chunks[1]!.relevanceScore).toBe(0.6);
  });

  it("is a no-op (byte-for-byte unchanged) when minRelevanceScore is omitted — the default/opt-in contract", async () => {
    mocks.query.mockResolvedValue({ matches: poolMatches });
    mocks.rerank.mockResolvedValue({
      data: [
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.6 },
        { index: 2, relevanceScore: 0.2 }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local"); // no options at all

    // All 3 survive (incl. the one that WOULD fail a 0.5 floor) — the floor never applied because
    // the caller didn't opt in.
    expect(chunks.map((c) => c.id)).toEqual(["high", "mid", "low"]);
  });

  it("keeps chunks with no relevanceScore (rerank off) even when minRelevanceScore is set — floor never blanks a no-rerank result", async () => {
    process.env.VECTOR_ENABLE_RERANK = "off";
    mocks.query.mockResolvedValue({ matches: poolMatches });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 4, "local", { minRelevanceScore: 0.9 });

    // Rerank never ran, so no chunk has a relevanceScore — the floor has nothing to filter and
    // every chunk (in cosine order) is kept, not silently dropped to zero results.
    expect(chunks.map((c) => c.id)).toEqual(["high", "mid", "low", "unscored"]);
    expect(chunks.every((c) => c.relevanceScore === undefined)).toBe(true);
  });
});

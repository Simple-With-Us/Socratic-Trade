/**
 * R2 (2026-07-01 expert review): embedding integrity guard, always-on (no flag). Rejects a
 * malformed or non-bijective embedding response instead of upserting degenerate or misbound vectors.
 * A document batch is atomic for integrity: one ambiguous item rejects every record in that batch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const index = vi.fn(() => ({ upsert, query }));
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn(),
    audit: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
      describeIndex: mocks.describeIndex,
      Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
});

describe("isValidEmbedding (pure predicate)", () => {
  it("accepts a non-empty array of finite numbers", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([0.1, 0.2, 0.3])).toBe(true);
  });
  it("rejects a non-array", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding(undefined)).toBe(false);
    expect(isValidEmbedding(null)).toBe(false);
    expect(isValidEmbedding("not an array")).toBe(false);
  });
  it("rejects an empty array", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([])).toBe(false);
  });
  it("rejects an array containing NaN or Infinity", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([0.1, NaN, 0.3])).toBe(false);
    expect(isValidEmbedding([0.1, Infinity, 0.3])).toBe(false);
    expect(isValidEmbedding([0.1, -Infinity, 0.3])).toBe(false);
  });
  it("rejects an array containing a non-number", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([0.1, "0.2" as any, 0.3])).toBe(false);
  });
});

describe("storeContexts: exact document-embedding response integrity", () => {
  it("fails the whole batch closed when one embedding is malformed", async () => {
    mocks.embed.mockResolvedValue({
      data: [
        { embedding: [0.1, 0.2] }, // healthy
        { embedding: [0.1, NaN] }, // poisoned — must be rejected, not upserted
        { embedding: [0.3, 0.4] } // healthy
      ]
    });

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([
      { text: "AAPL doc 1", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } },
      { text: "AAPL doc 2 (will be poisoned)", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } },
      { text: "AAPL doc 3", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);

    expect(result.indexed).toBe(0);
    expect(result.rejectedInvalidEmbeddings).toBe(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith("vector_embedding_integrity", expect.objectContaining({ rejected: 1 }), "local");
  });

  it.each([
    ["missing data", undefined],
    ["short response", [{ embedding: [0.1, 0.2] }]],
    ["overlong response", [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }, { embedding: [0.5, 0.6] }]],
    ["sparse/missing item", Object.assign(new Array(2), { 0: { embedding: [0.1, 0.2] } })],
    ["mixed index presence", [{ index: 0, embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }]],
    ["out-of-range index", [{ index: 0, embedding: [0.1, 0.2] }, { index: 2, embedding: [0.3, 0.4] }]],
    ["duplicate index", [{ index: 0, embedding: [0.1, 0.2] }, { index: 0, embedding: [0.3, 0.4] }]],
    ["missing embedding", [{ embedding: [0.1, 0.2] }, { index: undefined }]],
    ["malformed item", [{ embedding: [0.1, 0.2] }, null]]
  ])("rejects a %s without any Pinecone write", async (_label, data) => {
    mocks.embed.mockResolvedValue({ data });
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([
      { text: "AAPL doc 1", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } },
      { text: "AAPL doc 2", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);

    expect(result).toMatchObject({ indexed: 0 });
    expect(result.rejectedInvalidEmbeddings).toBeGreaterThan(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("uses explicit indices to restore request order instead of binding response-array position", async () => {
    mocks.embed.mockResolvedValue({
      data: [
        { index: 1, embedding: [0.9, 0.8] },
        { index: 0, embedding: [0.1, 0.2] }
      ]
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([
      { text: "first requested document", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20", accession: "first" } },
      { text: "second requested document", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20", accession: "second" } }
    ]);

    expect(result).toMatchObject({ indexed: 2 });
    const records = mocks.upsert.mock.calls[0]![0].records;
    expect(records.map((record: { values: number[] }) => record.values)).toEqual([[0.1, 0.2], [0.9, 0.8]]);
    expect(records.map((record: { metadata: { text: string } }) => record.metadata.text)).toEqual([
      "[Published: 2026-06-20] first requested document",
      "[Published: 2026-06-20] second requested document"
    ]);
  });

  it("does not report a rejection count when every embedding is healthy (byte-for-byte unaffected)", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([
      { text: "AAPL doc", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);
    expect(result.indexed).toBe(1);
    expect(result.rejectedInvalidEmbeddings).toBeUndefined();
  });

  it("continues later batches when one embed API call dies", async () => {
    process.env.VECTOR_EMBED_BATCH_SIZE = "1";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.embed
      .mockRejectedValueOnce(new Error("Embedding API failed (isOpenRouter=true): 500 boom"))
      .mockResolvedValue({ data: [{ embedding: [0.3, 0.4] }] });

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([
      { text: "doc one dies", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } },
      { text: "doc two lives", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);

    expect(result.error).toBeUndefined();
    expect(result.indexed).toBe(1);
    expect(result.rejectedInvalidEmbeddings).toBeGreaterThan(0);
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    delete process.env.VECTOR_EMBED_BATCH_SIZE;
  });
});

describe("retrieveContextDetailed: a malformed query embedding returns an empty result, not garbage matches", () => {
  it("returns [] and audits when Voyage returns a NaN-poisoned query embedding", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [NaN, NaN] }] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled(); // never even reaches Pinecone with a bad vector
    expect(mocks.audit).toHaveBeenCalledWith("vector_embedding_integrity", expect.objectContaining({ rejected: 1 }), "local");
  });

  it("returns [] when the query embed API throws instead of failing retrieval", async () => {
    mocks.embed.mockRejectedValue(new Error("Embedding API failed: 503"));
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("proceeds normally with a healthy query embedding (byte-for-byte unaffected)", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "hello", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).toEqual(["a"]);
  });
});

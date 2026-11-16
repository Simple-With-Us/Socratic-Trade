// G8(b) — query-embedding LRU cache around the single-query embed call in retrieveContextDetailed.
// Mirrors the mocking pattern in test/vector-db.test.ts (Pinecone/Voyage/db mocked at module level).
import { pinRagQualityFlagsOff } from "./rag-test-env";
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
    embed: vi.fn(),
    resolveApiKey: vi.fn(),
    meterEmbed: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
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
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  filterNewDocumentChunks: vi.fn((chunks) => chunks),
  insertDocumentChunks: vi.fn(),
  // retrieveContextDetailed now consults the per-user LLM budget (isOverLlmBudget → getPolicy). With
  // no budget configured, checkLlmDailyBudget short-circuits to ok (both limits +Infinity) without
  // touching the usage ledger, so a bare policy stub is enough to keep these cache tests budget-off.
  getPolicy: () => ({ tuning: {} }),
  DAILY_RESET_TIME_ZONE: "America/New_York",
  startOfDayInTimeZone: () => new Date(0)
}));

// Spy on the usage metering so we can assert a cache HIT is not metered as a real Voyage call.
// Keep the real `approxTokens` export — query embed now packs through embed-request-pack,
// which uses the same estimator as rag_usage.  A missing export threw before voyage.embed.
vi.mock("../src/lib/rag-metering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rag-metering")>();
  return {
    ...actual,
    estimateVoyageDispatchCost: vi.fn(() => 0),
    estimateRagDispatchCost: vi.fn(() => 0),
    meterEmbed: mocks.meterEmbed,
    meterPineconeQuery: vi.fn(),
    meterPineconeUpsert: vi.fn(),
    meterRerank: vi.fn(),
    recordRagUsage: vi.fn(),
    retrievalTelemetryEnabled: vi.fn(() => false),
    recordRetrievalQuality: vi.fn(),
    hashQuery: vi.fn((q: string) => q)
  };
});

beforeEach(() => {
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.RAG_QUERY_EMBED_CACHE;
  delete process.env.RAG_QUERY_EMBED_CACHE_MAX;
  delete process.env.RAG_QUERY_EMBED_CACHE_TTL_MS;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  mocks.query.mockResolvedValue({
    matches: [{ metadata: { text: "AAPL retrieved filing context", userId: "local", scope: "shared" } }]
  });
});

describe("query-embedding LRU cache (G8b)", () => {
  it("does not call embed a second time for an identical repeated query (default: cache on)", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local");
    await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // Pinecone is still queried each time — only the embed call is cached.
    expect(mocks.query).toHaveBeenCalledTimes(4); // private + shared pools on each retrieval
  });

  it("does NOT meter a cache hit as a Voyage embed call (usage/cost integrity)", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local"); // miss → embed + meter
    await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local"); // hit → no embed, no meter

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // The cache hit must NOT record a phantom embed usage row — meter count tracks real calls only.
    expect(mocks.meterEmbed).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a malformed query embedding — a transient bad embed must not poison the LRU", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    // First call: Voyage returns a malformed vector (NaN) the integrity guard rejects → returns [].
    mocks.embed.mockResolvedValueOnce({ data: [{ embedding: [Number.NaN, Number.NaN] }] });
    const first = await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local");
    expect(first).toEqual([]); // rejected, no context

    // Second identical call MUST re-hit Voyage (the bad response was not cached), and now succeeds.
    const second = await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local");
    expect(mocks.embed).toHaveBeenCalledTimes(2); // 2, not 1 → malformed response was never cached
    expect(second.length).toBeGreaterThan(0);
  });

  it("normalizes whitespace/casing so near-identical queries still hit the cache", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL Guidance", "AAPL", 2, "local");
    await retrieveContextDetailed("  aapl   guidance  ", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });

  it("calls embed again for a genuinely different query", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");
    await retrieveContextDetailed("AAPL insider selling", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache document/upsert embeddings — only the query path", async () => {
    const { storeContext, retrieveContextDetailed } = await import("../src/lib/vector-db");
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);

    await storeContext("AAPL guidance", { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" });
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");

    // Document embed (storeContext) + query embed (retrieveContextDetailed) — the shared normalized
    // text does not collapse them because caching only wraps the query-inputType call site.
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.embed.mock.calls[0][0]).toMatchObject({ inputType: "document" });
    expect(mocks.embed.mock.calls[1][0]).toMatchObject({ inputType: "query" });
  });

  it("can be disabled via RAG_QUERY_EMBED_CACHE=off, restoring one embed call per retrieval", async () => {
    process.env.RAG_QUERY_EMBED_CACHE = "off";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");
    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry once RAG_QUERY_EMBED_CACHE_MAX is exceeded", async () => {
    process.env.RAG_QUERY_EMBED_CACHE_MAX = "1";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("query one", "AAPL", 2, "local"); // embed #1, cached
    await retrieveContextDetailed("query two", "AAPL", 2, "local"); // embed #2, evicts "query one"
    await retrieveContextDetailed("query one", "AAPL", 2, "local"); // evicted -> embed #3

    expect(mocks.embed).toHaveBeenCalledTimes(3);
  });

  it("normalizeQueryCacheKey lowercases and collapses whitespace", async () => {
    const { normalizeQueryCacheKey } = await import("../src/lib/rag/query-embed-cache");
    expect(normalizeQueryCacheKey("  AAPL   Guidance ")).toBe("aapl guidance");
    expect(normalizeQueryCacheKey("aapl guidance")).toBe("aapl guidance");
  });
});

/**
 * hyde-multiquery-retrieval (2026-07-05): `RetrieveOptions.queries` wiring in
 * `retrieveContextDetailed` (vector-db.ts).
 *
 * Two things pinned here:
 *  1. Flags-off / `queries` omitted regression: EXACTLY one Voyage embed call and one independent
 *     private/shared Pinecone query pair. This is the
 *     hard invariant: multi-query/HyDE must never change behavior for every existing caller that
 *     doesn't pass `queries`.
 *  2. When `options.queries` IS supplied (a caller opted in, e.g. strategy.ts behind
 *     RAG_MULTIQUERY/RAG_HYDE), retrieval embeds+matches EACH query independently and RRF-fuses
 *     the per-query ranked pools into one candidate pool feeding the existing rankPool pipeline.
 *
 * Mocking pattern mirrors test/vector-db-hybrid.test.ts's "flag gate integration test" section
 * (full Pinecone/Voyage mock, no live network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    rerank: vi.fn(),
    resolveApiKey: vi.fn()
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
    return {
      embed: mocks.embed,
      rerank: mocks.rerank
    };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn()
}));

describe("retrieveContextDetailed: RetrieveOptions.queries wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env.PINECONE_API_KEY = "pinecone-test";
    process.env.VOYAGE_API_KEY = "voyage-test";
    process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
    process.env.VECTOR_ENABLE_RERANK = "off"; // isolate the embed/match fan-out from rerank behavior
    process.env.HYBRID_RETRIEVAL = "off";
    delete process.env.VECTOR_MIN_SCORE;
    delete process.env.RAG_QUERY_EMBED_CACHE; // keep default-ON cache semantics explicit per test

    mocks.resolveApiKey.mockImplementation((service: string) => {
      if (service === "pinecone") return process.env.PINECONE_API_KEY;
      if (service === "voyage") return process.env.VOYAGE_API_KEY;
      return undefined;
    });

    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  });

  afterEach(() => {
    delete process.env.VECTOR_ENABLE_RERANK;
    delete process.env.HYBRID_RETRIEVAL;
    delete process.env.RAG_QUERY_EMBED_CACHE;
  });

  it("flags-off / queries omitted: exactly one Voyage embed and one private/shared Pinecone pair", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL revenue", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(result.length).toBe(2);
  });

  it("queries: [] behaves the same as omitted — one embed and one private/shared query pair", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } }]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local", { queries: [] });

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("with queries: [q1, q2, q3] supplied, embeds+matches each query independently PLUS the original primary query (one embed + one Pinecone query call per variant, plus one for the primary)", async () => {
    mocks.embed.mockImplementation(({ input }: { input: string[] }) =>
      Promise.resolve({ data: [{ embedding: [input[0]!.length, 0.2, 0.3] }] })
    );
    mocks.query.mockImplementation(({ vector }: { vector: number[] }) => {
      // Return a query-specific match set so we can tell which query produced which result.
      const tag = vector[0];
      return Promise.resolve({
        matches: [{ id: `match-${tag}`, score: 0.9, metadata: { text: `text for ${tag}`, userId: "local", scope: "shared" } }]
      });
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const variants = ["AAPL risk factors", "AAPL guidance outlook", "AAPL litigation disclosures"];
    const result = await retrieveContextDetailed("AAPL primary query", "AAPL", 4, "local", { queries: variants });

    // 4 embeds: one per variant query PLUS the original primary query (2026-07-05 review fix —
    // the primary query's dense recall is augmented, not replaced, by the fan-out).
    expect(mocks.embed).toHaveBeenCalledTimes(4);
    expect(mocks.query).toHaveBeenCalledTimes(8);
    // All four fused matches should surface (distinct ids, RRF-merged pool).
    expect(result.length).toBe(4);
  });

  it("with queries supplied, RRF-fuses overlapping per-query pools so a match appearing in multiple queries ranks first", async () => {
    mocks.embed.mockImplementation(({ input }: { input: string[] }) =>
      Promise.resolve({ data: [{ embedding: [input[0]!.length, 0, 0] }] })
    );
    // Query 1 and 2 both return "shared", only query 2 also returns "onlyq2".
    let callCount = 0;
    mocks.query.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          matches: [{ id: "shared", score: 0.9, metadata: { text: "shared doc", userId: "local", scope: "shared" } }]
        });
      }
      return Promise.resolve({
        matches: [
          { id: "shared", score: 0.85, metadata: { text: "shared doc", userId: "local", scope: "shared" } },
          { id: "onlyq2", score: 0.7, metadata: { text: "only in q2", userId: "local", scope: "shared" } }
        ]
      });
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("primary", "AAPL", 5, "local", { queries: ["q1", "q2"] });

    expect(result.length).toBeGreaterThanOrEqual(2);
    // "shared" (appearing in both per-query pools) should be the top-ranked chunk after RRF fusion.
    expect(result[0]!.text).toBe("shared doc");
  });

  it("with queries supplied, falls back to the plain single-query path (not []) when every variant's embedding is malformed", async () => {
    // 2026-07-05 review fix (Finding 1): the fan-out must fail OPEN — when every variant (including
    // the always-included primary `query`) embeds to a malformed vector, retrieveContextDetailed
    // used to return `[]` outright. It must instead fall back to the plain single-query path (i.e.
    // behave exactly as flags-off), per the module's own "always falls back to the caller's
    // original single query, never throws" contract. Here ALL embeddings are malformed, so even the
    // fallback's single-query embed is malformed too, and `[]` is the correct terminal result — but
    // it must come from the single-query path, not from an empty fan-out short-circuit.
    mocks.embed.mockResolvedValue({ data: [{ embedding: [NaN, NaN, NaN] }] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("primary", "AAPL", 3, "local", { queries: ["q1", "q2"] });

    expect(result).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
    // One embed per fan-out entry (primary + q1 + q2 = 3) plus one retry embed for the fallback's
    // single-query path = 4 total embed attempts, all malformed.
    expect(mocks.embed).toHaveBeenCalledTimes(4);
  });

  it("with queries supplied, when ONE variant's Voyage/Pinecone call rejects, the OTHER variants' results still surface (fail-open, no throw)", async () => {
    // 2026-07-05 review fix (Finding 1, BLOCKER): embedAndMatchOneQuery has no internal catch and
    // withRagApiHealth/embedWithRetry rethrow on a transient provider error, so a bare Promise.all
    // over the fan-out used to let ONE variant's rejection reject the WHOLE Promise.all, discarding
    // every other variant's already-successful results and returning `[]` from the outer catch.
    // Each fan-out call must now be caught individually so surviving variants still contribute.
    let embedCall = 0;
    mocks.embed.mockImplementation(({ input }: { input: string[] }) => {
      embedCall++;
      // The second embed call (whichever query it is) fails; the rest succeed.
      if (embedCall === 2) return Promise.reject(new Error("Voyage 500"));
      return Promise.resolve({ data: [{ embedding: [input[0]!.length, 0.2, 0.3] }] });
    });
    mocks.query.mockImplementation(({ vector }: { vector: number[] }) => {
      const tag = vector[0];
      return Promise.resolve({
        matches: [{ id: `match-${tag}`, score: 0.9, metadata: { text: `text for ${tag}`, userId: "local", scope: "shared" } }]
      });
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const variants = ["AAPL risk factors", "AAPL guidance outlook"];
    const result = await retrieveContextDetailed("AAPL primary query", "AAPL", 5, "local", { queries: variants });

    // Fan-out is [primary, ...variants] = 3 embeds attempted; one rejects, two succeed.
    expect(mocks.embed).toHaveBeenCalledTimes(3);
    // The whole call must NOT throw, and the surviving variants' matches must surface.
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

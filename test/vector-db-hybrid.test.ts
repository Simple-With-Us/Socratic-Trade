/**
 * Tests for the hybrid dense+BM25 (RRF) retrieval helpers and the HYBRID_RETRIEVAL flag gate.
 *
 * Structure:
 *  1. Pure function tests (no mocking needed): tokenize, rrfFuse, bm25Scores, fuseHybrid
 *  2. Flag gate integration test (full-mock setup from vector-db.test.ts pattern)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bm25Scores, fuseHybrid, rrfFuse, tokenize } from "../src/lib/rag/hybrid";

// ---------------------------------------------------------------------------
// 1. Pure function tests — import directly, no vi.mock needed
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric, keeping ticker-like tokens", () => {
    expect(tokenize("AAPL 10-K filing")).toEqual(["aapl", "10", "k", "filing"]);
    expect(tokenize("  hello, world! ")).toEqual(["hello", "world"]);
    expect(tokenize("")).toEqual([]);
  });

  it("handles strings with only punctuation/whitespace", () => {
    expect(tokenize("--- *** ")).toEqual([]);
  });

  it("preserves numeric tokens", () => {
    expect(tokenize("Q4 2026 accession 0001234567-26-000123")).toEqual([
      "q4", "2026", "accession", "0001234567", "26", "000123"
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("rrfFuse", () => {
  it("single list: returns ids in same order as the input list", () => {
    expect(rrfFuse([["a", "b", "c"]])).toEqual(["a", "b", "c"]);
  });

  it("two lists: docs appearing in both rank higher than docs in only one", () => {
    // a = 1/61 + 1/62 ≈ 0.032522  (rank 1 in list1, rank 2 in list2)
    // c = 1/63 + 1/61 ≈ 0.032266  (rank 3 in list1, rank 1 in list2)
    // b = 1/62 + 1/63 ≈ 0.032002  (rank 2 in list1, rank 3 in list2)
    const result = rrfFuse([["a", "b", "c"], ["c", "a", "b"]]);
    expect(result).toEqual(["a", "c", "b"]);
  });

  it("is deterministic: same inputs always produce same output", () => {
    const a = rrfFuse([["x", "y", "z"], ["z", "x", "y"]]);
    const b = rrfFuse([["x", "y", "z"], ["z", "x", "y"]]);
    expect(a).toEqual(b);
  });

  it("accepts an arbitrary number of lists (3 lists)", () => {
    // "shared" appears in all three lists → highest RRF score.
    // "only1" appears in only list1 → lowest score.
    const result = rrfFuse([
      ["shared", "only1"],
      ["shared", "only2"],
      ["shared", "only3"]
    ]);
    // "shared" must rank first — it's in all three.
    expect(result[0]).toBe("shared");
    // The singletons must all be present somewhere.
    expect(result).toContain("only1");
    expect(result).toContain("only2");
    expect(result).toContain("only3");
  });

  it("k parameter shifts scores but not relative order for same-position docs", () => {
    expect(rrfFuse([["a", "b"]], 30)).toEqual(["a", "b"]);
    expect(rrfFuse([["a", "b"]], 60)).toEqual(["a", "b"]);
  });

  it("docs missing from a list get no contribution from that list (absent = unranked)", () => {
    // b is in both lists → highest score.
    // a is only in list1; c is only in list2.
    const result = rrfFuse([["a", "b"], ["b", "c"]]);
    expect(result[0]).toBe("b");
  });

  it("empty lists are handled gracefully", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[]])).toEqual([]);
    // Mixed: one real list, one empty — should not throw.
    expect(() => rrfFuse([["a"], []])).not.toThrow();
    const r = rrfFuse([["a"], []]);
    expect(r).toContain("a");
  });

  it("does not throw when a list entry is not a string (defensive)", () => {
    expect(() => rrfFuse([["a", "b"], ["" as any]])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("bm25Scores", () => {
  it("exact-term document scores higher than non-matching document", () => {
    const docs = ["AAPL earnings beat estimates", "MSFT revenue declined"];
    const scores = bm25Scores("AAPL earnings", docs);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });

  it("returns zeros for all docs when query has no terms in any doc", () => {
    const docs = ["hello world", "foo bar"];
    const scores = bm25Scores("xyzzy", docs);
    expect(scores).toEqual([0, 0]);
  });

  it("document with higher term frequency scores higher (all else equal)", () => {
    const docs = ["AAPL AAPL AAPL", "AAPL other content"];
    const scores = bm25Scores("aapl", docs);
    // BM25 TF normalization dampens raw TF, but first doc should still score higher.
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });

  it("returns parallel array of same length as docs", () => {
    expect(bm25Scores("q", ["a", "b", "c"])).toHaveLength(3);
  });

  it("empty corpus returns empty array", () => {
    expect(bm25Scores("q", [])).toEqual([]);
  });

  it("single-doc corpus: matching doc scores > 0, non-matching doc scores 0", () => {
    expect(bm25Scores("aapl", ["aapl earnings"])[0]).toBeGreaterThan(0);
    expect(bm25Scores("aapl", ["msft earnings"])[0]).toBe(0);
  });

  it("all scores are non-negative", () => {
    const docs = ["AAPL quarterly earnings report", "SEC 10-K annual filing AAPL"];
    const scores = bm25Scores("AAPL 10-K", docs);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------

const m = (id: string, text: string, score: number) => ({ id, score, metadata: { text } });

describe("fuseHybrid", () => {
  it("returns matches in dense order when BM25 agrees with dense", () => {
    // All docs have non-overlapping terms; the densest is also most lexically relevant.
    const matches = [
      m("a", "aapl quarterly earnings beat", 0.9),
      m("b", "msft revenue report", 0.8),
      m("c", "googl cloud segment", 0.7)
    ];
    const result = fuseHybrid("aapl quarterly", matches);
    // "a" has both query terms; it should stay at or near the top.
    expect(result[0]!.id).toBe("a");
    expect(result).toHaveLength(3);
  });

  it("reorders: exact-term match moves up when BM25 favors it over dense order", () => {
    // Dense order: a (0.9) > b (0.8) > c (0.7).
    // BM25 for query "AAPL accession": only c has both terms.
    const matches = [
      m("a", "unrelated content about markets", 0.9),
      m("b", "other stuff revenue growth", 0.8),
      m("c", "AAPL 10-K accession number filing", 0.7)
    ];
    const result = fuseHybrid("AAPL accession", matches);
    // c should move up (BM25 favors it strongly).
    const cIdx = result.findIndex((x: any) => x.id === "c");
    expect(cIdx).toBeLessThanOrEqual(1); // c should be rank 0 or 1 after fusion
  });

  it("handles matches with undefined id (assigns synthetic id, returns full match shape)", () => {
    const noId = { score: 0.8, metadata: { text: "AAPL report" } }; // no id field
    const withId = m("b", "MSFT report", 0.7);
    const result = fuseHybrid("AAPL", [noId, withId]);
    expect(result).toHaveLength(2);
    // Both original objects are returned (shape preserved).
    expect(result.some((x: any) => x === noId || (x.score === 0.8 && !x.id))).toBe(true);
  });

  it("returns matches unchanged on empty input", () => {
    expect(fuseHybrid("q", [])).toEqual([]);
  });

  it("returns single match unchanged (pool.length <= 1)", () => {
    const match = m("a", "text", 0.9);
    const result = fuseHybrid("q", [match]);
    expect(result).toEqual([match]);
  });

  it("falls back to input order on error (defensive)", () => {
    // Passing null in the array to force an error path.
    const matches = [m("a", "text", 0.9), null as any];
    expect(() => fuseHybrid("q", matches)).not.toThrow();
    // Should return something (either original or partially fused) without throwing.
    const result = fuseHybrid("q", matches);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Flag gate integration test — full-mock setup (pattern from vector-db.test.ts)
// ---------------------------------------------------------------------------

// We need to hoist ALL mocks before any imports of the mocked modules.
const integrationMocks = vi.hoisted(() => {
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
    resolveApiKey: vi.fn(),
    // Spy that records calls but delegates to the real fuseHybrid (set in the mock factory below).
    fuseHybridSpy: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: integrationMocks.listIndexes,
      createIndex: integrationMocks.createIndex,
      Index: integrationMocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return {
      embed: integrationMocks.embed,
      rerank: integrationMocks.rerank
    };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: integrationMocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn()
}));

vi.mock("../src/lib/rag/hybrid", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/rag/hybrid")>();
  // Wire the spy to call through to the real implementation so pure-function tests are unaffected.
  // The spy simply records the call and delegates — enabling flag-gate assertions without altering behavior.
  integrationMocks.fuseHybridSpy.mockImplementation(original.fuseHybrid);
  return {
    ...original,
    fuseHybrid: integrationMocks.fuseHybridSpy
  };
});

// Save/restore HYBRID_RETRIEVAL across tests.
let savedHybridEnv: string | undefined;

describe("flag gate: HYBRID_RETRIEVAL in retrieveContextDetailed", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    savedHybridEnv = process.env.HYBRID_RETRIEVAL;
    delete process.env.HYBRID_RETRIEVAL;

    process.env.PINECONE_API_KEY = "pinecone-test";
    process.env.VOYAGE_API_KEY = "voyage-test";
    process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
    process.env.VECTOR_ENABLE_RERANK = "off"; // Disable reranking for flag-gate tests
    delete process.env.VECTOR_MIN_SCORE;

    integrationMocks.resolveApiKey.mockImplementation((service: string) => {
      if (service === "pinecone") return process.env.PINECONE_API_KEY;
      if (service === "voyage") return process.env.VOYAGE_API_KEY;
      return undefined;
    });

    // Index already exists.
    integrationMocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });

    // Embed returns a query vector.
    integrationMocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  });

  afterEach(() => {
    if (savedHybridEnv === undefined) {
      delete process.env.HYBRID_RETRIEVAL;
    } else {
      process.env.HYBRID_RETRIEVAL = savedHybridEnv;
    }
    delete process.env.VECTOR_ENABLE_RERANK;
  });

  it("when HYBRID_RETRIEVAL=off (default), fuseHybrid is NOT called", async () => {
    process.env.HYBRID_RETRIEVAL = "off";

    // Two matches with text (pool.length > 1 so the guard wouldn't be the reason).
    integrationMocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL revenue", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local");

    expect(integrationMocks.fuseHybridSpy).not.toHaveBeenCalled();
  });

  it("when HYBRID_RETRIEVAL is absent (default off), fuseHybrid is NOT called", async () => {
    // HYBRID_RETRIEVAL is already deleted in beforeEach.
    integrationMocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL revenue", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local");

    expect(integrationMocks.fuseHybridSpy).not.toHaveBeenCalled();
  });

  it("when HYBRID_RETRIEVAL=on, fuseHybrid IS called with the candidate pool", async () => {
    process.env.HYBRID_RETRIEVAL = "on";

    integrationMocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings beat estimates", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL quarterly revenue", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local");

    expect(integrationMocks.fuseHybridSpy).toHaveBeenCalledTimes(1);
    expect(integrationMocks.fuseHybridSpy).toHaveBeenCalledWith(
      "AAPL earnings",
      expect.any(Array)
    );
  });

  it("HYBRID_RETRIEVAL=on with 1-match pool skips fusion (pool.length > 1 guard)", async () => {
    process.env.HYBRID_RETRIEVAL = "on";

    // Only one match returned.
    integrationMocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL only result", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 1, "local");

    // pool.length is 1, so hybridRetrievalEnabled() is true but pool.length > 1 is false.
    expect(integrationMocks.fuseHybridSpy).not.toHaveBeenCalled();
  });

  it("HYBRID_RETRIEVAL truthy values: 'true', '1', 'yes' all enable fusion", async () => {
    for (const val of ["true", "1", "yes"]) {
      vi.clearAllMocks();
      process.env.HYBRID_RETRIEVAL = val;

      integrationMocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      integrationMocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      integrationMocks.resolveApiKey.mockImplementation((service: string) => {
        if (service === "pinecone") return process.env.PINECONE_API_KEY;
        if (service === "voyage") return process.env.VOYAGE_API_KEY;
        return undefined;
      });
      integrationMocks.query.mockResolvedValue({
        matches: [
          { id: "a", score: 0.9, metadata: { text: "text a", userId: "local", scope: "shared" } },
          { id: "b", score: 0.8, metadata: { text: "text b", userId: "local", scope: "shared" } }
        ]
      });

      const { retrieveContextDetailed } = await import("../src/lib/vector-db");
      await retrieveContextDetailed("q", "AAPL", 2, "local");

      expect(integrationMocks.fuseHybridSpy).toHaveBeenCalled();

      // Reset modules for the next iteration.
      vi.resetModules();
    }
  });
});

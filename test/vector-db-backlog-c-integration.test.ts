/**
 * Integration tests for the 2026-07-01 RAG backlog items wired into vector-db.ts:
 *   R5  — consolidated per-retrieval telemetry (recordRetrievalQuality)
 *   R7  — index-metric assertion at bootstrap (describeIndex, cached, warn-only)
 *   R9  — query-embedding LRU (RAG_QUERY_EMBED_CACHE)
 *   R10 — content_hash dedup for storeContexts (dedupKeyPrefix)
 *   R12 — centralize default cosine floor for new callers (applyDefaultFloors)
 *   R14 — near-duplicate suppression (dedupeSimilarity)
 *   R16 — per-run RAG budget ceiling with graceful degradation (RAG_RUN_BUDGET_ENABLED)
 *   R17 — fix train/serve text skew (VECTOR_EMBED_CLEAN_TEXT)
 *
 * All full-mock (no live Pinecone/Voyage) — the same pattern as test/vector-db.test.ts.
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
    rerank: vi.fn(),
    resolveApiKey: vi.fn(),
    audit: vi.fn(),
    getInternalSetting: vi.fn(),
    setInternalSetting: vi.fn(),
    filterNewDocumentChunks: vi.fn(),
    insertDocumentChunks: vi.fn(),
    captureMessage: vi.fn(),
    withScope: vi.fn(),
    scopeSetLevel: vi.fn(),
    scopeSetTag: vi.fn(),
    scopeSetContext: vi.fn(),
    scopeSetFingerprint: vi.fn(),
    getRagUsageSummary: vi.fn(() => [] as Array<{
      userId: string;
      operation: string;
      provider: string;
      model: string | null;
      calls: number;
      tokensIn: number;
      tokensOut: number;
      batchCount: number;
      costEstUsd: number;
    }>)
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
    return { embed: mocks.embed, rerank: mocks.rerank };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  getInternalSetting: mocks.getInternalSetting,
  setInternalSetting: mocks.setInternalSetting,
  filterNewDocumentChunks: mocks.filterNewDocumentChunks,
  insertDocumentChunks: mocks.insertDocumentChunks
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  withScope: mocks.withScope
}));

vi.mock("../src/lib/rag-metering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rag-metering")>();
  return { ...actual, getRagUsageSummary: mocks.getRagUsageSummary };
});

function resetEnv() {
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  delete process.env.RAG_QUERY_EMBED_CACHE;
  // Pin quality/telemetry flags OFF so each test opts in explicitly (production defaults are ON
  // as of owner enablement 2026-07-24; tests must not depend on unset==off).
  process.env.RAG_RUN_BUDGET_ENABLED = "off";
  delete process.env.RAG_RUN_BUDGET_CEILING;
  delete process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED;
  delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
  process.env.RAG_APPLY_DEFAULT_FLOORS = "off";
  process.env.RAG_RETRIEVAL_TELEMETRY = "off";
  process.env.RAG_CORPUS_WIDE_LEXICAL = "off";
  process.env.RAG_PARENT_CONTEXT_EXPANSION = "off";
  process.env.VECTOR_ASOF_SERVER_FILTER = "off";
  delete process.env.VECTOR_MIN_SCORE;
  delete process.env.VECTOR_ENABLE_RERANK;
  delete process.env.HYBRID_RETRIEVAL;
  delete process.env.SENTRY_DSN;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.getRagUsageSummary.mockReset();
  mocks.getRagUsageSummary.mockReturnValue([]);
  resetEnv();
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.getInternalSetting.mockReturnValue(undefined);
  mocks.withScope.mockImplementation((callback: (scope: {
    setLevel: typeof mocks.scopeSetLevel;
    setTag: typeof mocks.scopeSetTag;
    setContext: typeof mocks.scopeSetContext;
    setFingerprint: typeof mocks.scopeSetFingerprint;
  }) => void) => callback({
    setLevel: mocks.scopeSetLevel,
    setTag: mocks.scopeSetTag,
    setContext: mocks.scopeSetContext,
    setFingerprint: mocks.scopeSetFingerprint
  }));
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.filterNewDocumentChunks.mockImplementation((hashes: any[]) => hashes);
});

// ── R7: index-metric assertion ──────────────────────────────────────────────

describe("R7: index-metric assertion at bootstrap", () => {
  it("calls describeIndex once per index-init cache key and does NOT warn when metric is cosine", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([{ text: "doc one", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }]);
    await storeContexts([{ text: "doc two", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18" } }]);

    expect(mocks.describeIndex).toHaveBeenCalledTimes(1); // cached — not called again for the 2nd storeContexts
    expect(mocks.audit).not.toHaveBeenCalledWith("vector_index_metric_mismatch", expect.anything(), expect.anything());
    warnSpy.mockRestore();
  });

  it("warns (not throws) and audits when the index metric is NOT cosine", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    mocks.describeIndex.mockResolvedValue({ metric: "euclidean" });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([{ text: "doc", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }]);

    expect(result.error).toBeUndefined(); // never throws — storeContexts still succeeds
    expect(mocks.audit).toHaveBeenCalledWith(
      "vector_index_metric_mismatch",
      expect.objectContaining({ metric: "euclidean" }),
      "local"
    );
    expect(warnSpy).toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.captureMessage).toHaveBeenCalledWith("Pinecone index metric mismatch"));
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("component", "rag");
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("rag.provider", "pinecone");
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("rag.operation", "describeIndex");
    expect(mocks.scopeSetContext).toHaveBeenCalledWith("rag", expect.objectContaining({
      indexName: "socratic-trade",
      metric: "euclidean",
      expectedMetric: "cosine"
    }));
    warnSpy.mockRestore();
  });

  it("never throws when describeIndex itself fails (best-effort check)", async () => {
    mocks.describeIndex.mockRejectedValue(new Error("control-plane timeout"));
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([{ text: "doc", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }]);
    expect(result.indexed).toBe(1); // storage still succeeds despite describeIndex failing
  });
});

// ── R9: query-embedding LRU ──────────────────────────────────────────────────

describe("R9: query-embedding LRU cache", () => {
  it("default ON (consolidated G8b): a repeated identical query reuses the cached vector", async () => {
    // resetEnv() clears RAG_QUERY_EMBED_CACHE, so the consolidated default (ON) applies with no env set.
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({ matches: [] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");
    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1); // cached by default — second call is a hit
    expect(mocks.query).toHaveBeenCalledTimes(4); // private + shared pools still run fresh both times
  });

  it("opt-out (RAG_QUERY_EMBED_CACHE=off): embeds fresh on every call, even for the identical query", async () => {
    process.env.RAG_QUERY_EMBED_CACHE = "off";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({ matches: [] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");
    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(2); // caching disabled → fresh embed each call
  });

  it("when ON: a repeated identical query reuses the cached vector (embed called once)", async () => {
    process.env.RAG_QUERY_EMBED_CACHE = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({ matches: [] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");
    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(mocks.query).toHaveBeenCalledTimes(4); // private + shared pools still run fresh both times
  });

  it("when ON: per-user filters still apply after a cache hit (cache is vector-only, not results)", async () => {
    process.env.RAG_QUERY_EMBED_CACHE = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({ matches: [] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "local");
    await retrieveContextDetailed("AAPL supply chain risk", "AAPL", 3, "user-42");

    // Same query, different userId: embed is cached (1 call), but query() is invoked per-user
    // with the user-scoped filter — cache hit doesn't skip the per-user Pinecone query at all.
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // user-42 triggers 2 queries internally (user-scoped + shared-tier), "local" triggers 1.
    expect(mocks.query.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ── R10: content_hash dedup for storeContexts ────────────────────────────────

describe("R10: content_hash dedup for storeContexts (dedupKeyPrefix)", () => {
  it("default (no dedupKeyPrefix): always embeds, never calls filterNewDocumentChunks", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([{ text: "doc", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }]);

    expect(mocks.filterNewDocumentChunks).not.toHaveBeenCalled();
    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });

  it("with dedupKeyPrefix: skips embedding a document whose hash is already indexed", async () => {
    mocks.filterNewDocumentChunks.mockImplementation(() => []); // everything already indexed
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts(
      [{ text: "an unchanged summary", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }],
      "local",
      { dedupKeyPrefix: "sec8k-summary" }
    );

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.attempted).toBe(1); // attempted still reports the true input count
  });

  it("with dedupKeyPrefix: embeds a NEW document and records its hash via insertDocumentChunks", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts(
      [{ text: "a fresh summary", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }],
      "local",
      { dedupKeyPrefix: "sec8k-summary" }
    );

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(result.indexed).toBe(1);
    expect(mocks.insertDocumentChunks).toHaveBeenCalledWith([
      expect.objectContaining({ source: "sec8k-summary:sec-8k" })
    ]);
  });

  it("keys dedup on TEXT content, not accession — a changed accession with byte-identical text is still deduped", async () => {
    // Simulate: the check returns nothing new because this exact text hash already exists in
    // document_chunks, regardless of what accession/id metadata says.
    mocks.filterNewDocumentChunks.mockImplementation(() => []);
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts(
      [{ text: "identical text across two different accessions", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "NEW-ACCESSION-999" } }],
      "local",
      { dedupKeyPrefix: "sec8k-summary" }
    );

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });
});

// ── R12: centralize default cosine floor (applyDefaultFloors) ───────────────

describe("R12: applyDefaultFloors", () => {
  it("default (unset): no floor applied when minScore is omitted", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "low", score: 0.01, metadata: { text: "low score chunk", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).toContain("low"); // NOT filtered — no floor applied by default
  });

  it("applyDefaultFloors=true applies defaultMinScore() when minScore is omitted", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "low", score: 0.01, metadata: { text: "low score chunk", userId: "local", scope: "shared" } },
        { id: "high", score: 0.9, metadata: { text: "high score chunk", userId: "local", scope: "shared" } }
      ]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { applyDefaultFloors: true });
    expect(chunks.map((c) => c.id)).not.toContain("low"); // dropped by the default 0.30 floor
    expect(chunks.map((c) => c.id)).toContain("high");
  });

  it("does NOT override an explicit minScore (existing callers are byte-for-byte unchanged)", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "mid", score: 0.5, metadata: { text: "mid score chunk", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    // Explicit minScore of 0 (disable floor) must win even with applyDefaultFloors set.
    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local", { minScore: 0, applyDefaultFloors: true });
    expect(chunks.map((c) => c.id)).toContain("mid");
  });

  it("RAG_APPLY_DEFAULT_FLOORS env var has the same effect as the per-call option", async () => {
    process.env.RAG_APPLY_DEFAULT_FLOORS = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "low", score: 0.01, metadata: { text: "low score chunk", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    const chunks = await retrieveContextDetailed("q", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).not.toContain("low");
  });
});

// ── R16: per-run RAG budget ceiling ──────────────────────────────────────────

describe("R16: per-run RAG budget ceiling with graceful degradation", () => {
  it("default OFF: rerank still runs normally regardless of call volume", async () => {
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const pool = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      score: 0.9 - i * 0.05,
      metadata: { text: `chunk ${i} about revenue`, userId: "local", scope: "shared" }
    }));
    mocks.query.mockResolvedValue({ matches: pool });
    mocks.rerank.mockResolvedValue({ data: pool.map((_, i) => ({ index: i, relevanceScore: 0.5 })) });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("q", "AAPL", 2, "local");
    expect(mocks.rerank).toHaveBeenCalled();
  });

  it("when tripped: degrades by skipping rerank/hybrid only, core recall still returns results", async () => {
    process.env.RAG_RUN_BUDGET_ENABLED = "on";
    process.env.RAG_RUN_BUDGET_CEILING = "1";
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const pool = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      score: 0.9 - i * 0.05,
      metadata: { text: `chunk ${i} about revenue`, userId: "local", scope: "shared" }
    }));
    mocks.query.mockResolvedValue({ matches: pool });
    mocks.rerank.mockResolvedValue({ data: pool.map((_, i) => ({ index: i, relevanceScore: 0.5 })) });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const { resetRunBudget } = await import("../src/lib/rag/run-budget");
    resetRunBudget();

    // First call trips the budget (1 embed op counted, ceiling=1).
    const first = await retrieveContextDetailed("q1", "AAPL", 2, "local");
    expect(first.length).toBeGreaterThan(0); // core recall unaffected

    // Second call should now be degraded: rerank must be skipped.
    mocks.rerank.mockClear();
    const second = await retrieveContextDetailed("q2", "AAPL", 2, "local");
    expect(second.length).toBeGreaterThan(0); // still returns core dense-cosine results
    expect(mocks.rerank).not.toHaveBeenCalled(); // degraded: rerank skipped
  });

  it("keeps local corpus-wide lexical over-fetch enabled during budget degradation", async () => {
    process.env.RAG_RUN_BUDGET_ENABLED = "on";
    process.env.RAG_RUN_BUDGET_CEILING = "1";
    process.env.RAG_CORPUS_WIDE_LEXICAL = "on";
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({ matches: [{ id: "c0", score: 0.9, metadata: { text: "chunk", userId: "local", scope: "shared" } }] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const { resetRunBudget } = await import("../src/lib/rag/run-budget");
    resetRunBudget();

    await retrieveContextDetailed("q1", "AAPL", 2, "local");
    mocks.query.mockClear();
    await retrieveContextDetailed("q2", "AAPL", 2, "local");

    expect(mocks.query.mock.calls.some(([request]) => request.topK === 10)).toBe(true);
  });
});

// ── R5: consolidated per-retrieval telemetry ────────────────────────────────

describe("R5: consolidated per-retrieval telemetry (recordRetrievalQuality)", () => {
  it("explicitly OFF: never calls audit with rag_retrieval_quality", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.5, metadata: { text: "chunk", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("q", "AAPL", 3, "local");

    expect(mocks.audit).not.toHaveBeenCalledWith("rag_retrieval_quality", expect.anything(), expect.anything());
  });

  it("when ON: records a hashed query (never the raw query text) with the expected fields", async () => {
    process.env.RAG_RETRIEVAL_TELEMETRY = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "chunk a", userId: "local", scope: "shared" } },
        { id: "b", score: 0.01, metadata: { text: "chunk b", userId: "local", scope: "shared" } }
      ]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    const rawQuery = "very specific private query text";
    await retrieveContextDetailed(rawQuery, "AAPL", 3, "local", { minScore: 0.3 });

    const call = mocks.audit.mock.calls.find((c: any[]) => c[0] === "rag_retrieval_quality");
    expect(call).toBeTruthy();
    const payload = call![1];
    expect(payload.queryHash).not.toContain(rawQuery); // raw query text must never appear
    expect(typeof payload.queryHash).toBe("string");
    expect(payload.queryHash).toHaveLength(16); // SHA-256 first-16-hex
    expect(payload.k).toBe(3);
    expect(payload.candidates).toBe(2);
    expect(payload.droppedByMinScore).toBe(1); // "b" (0.01) dropped by minScore=0.3
    expect(payload.finalCount).toBe(1);
    delete process.env.RAG_RETRIEVAL_TELEMETRY;
  });
});

// ── R14: near-duplicate suppression wired end-to-end ─────────────────────────

describe("R14: near-duplicate suppression (dedupeSimilarity) wired into retrieveContextDetailed", () => {
  it("default (unset): a near-duplicate restatement is NOT suppressed", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "Apple reported strong iPhone sales growth this quarter driven by upgrades", userId: "local", scope: "shared" } },
        { id: "a-dup", score: 0.89, metadata: { text: "Apple reported strong iPhone sales growth this quarter driven by upgrades and services", userId: "local", scope: "shared" } }
      ]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    const chunks = await retrieveContextDetailed("q", "AAPL", 2, "local");
    expect(chunks.map((c) => c.id)).toEqual(["a", "a-dup"]);
  });

  it("with dedupeSimilarity set: suppresses the near-duplicate and back-fills from the pool", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "Apple reported strong iPhone sales growth this quarter driven by upgrades", userId: "local", scope: "shared" } },
        { id: "a-dup", score: 0.89, metadata: { text: "Apple reported strong iPhone sales growth this quarter driven by upgrades and services", userId: "local", scope: "shared" } },
        { id: "b", score: 0.5, metadata: { text: "Completely unrelated passage about supply chain logistics risk factors", userId: "local", scope: "shared" } }
      ]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    const chunks = await retrieveContextDetailed("q", "AAPL", 2, "local", { dedupeSimilarity: 0.5 });
    const ids = chunks.map((c) => c.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("a-dup"); // suppressed as a near-duplicate of "a"
    expect(ids).toContain("b"); // back-filled to still reach limit=2
  });
});

// ── WU budget: prevent Pinecone write-unit runaway before embedding ─────────

describe("Pinecone write-unit budget", () => {
  it("skips before Voyage embed when the estimated Pinecone WU budget is exhausted", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "1";
    // used>0 so this is a spent window, not the zero-used remainder deadlock.
    mocks.getRagUsageSummary.mockReturnValue([{
      userId: "local",
      operation: "upsert",
      provider: "pinecone",
      model: null,
      calls: 1,
      tokensIn: 10,
      tokensOut: 1,
      batchCount: 1,
      costEstUsd: 0
    }]);
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([
      { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.writeUnitBudgetSkipped).toBe(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      "vector_write_unit_budget",
      expect.objectContaining({ skipped: 1, limitPer24h: 1 }),
      "local"
    );
    await vi.waitFor(() => expect(mocks.captureMessage).toHaveBeenCalledWith("Pinecone write unit budget reached"));
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("rag.provider", "pinecone");
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("rag.operation", "upsert-budget");
    expect(mocks.scopeSetContext).toHaveBeenCalledWith("rag", expect.objectContaining({
      requestedEstimatedWriteUnits: expect.any(Number),
      allowedEstimatedWriteUnits: 0,
      skipped: 1,
      limitPer24h: 1
    }));
  });

  it("embeds the first document of a zero-used window even when the estimate exceeds a collapsed cap", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "15";
    mocks.getRagUsageSummary.mockReturnValue([]);
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.upsert.mockResolvedValue({});
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([
      { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);

    expect(mocks.embed).toHaveBeenCalled();
    expect(result.writeUnitBudgetSkipped ?? 0).toBe(0);
    expect(result.skipped).not.toBe(true);
  });

  it("reports provider failures to Sentry without throwing from storeContexts", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.upsert.mockRejectedValue(new Error("Pinecone 503 unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([
      { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);

    expect(result.error).toContain("Pinecone 503 unavailable");
    await vi.waitFor(() => expect(mocks.captureMessage).toHaveBeenCalledWith("Pinecone connection failed"));
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("rag.provider", "pinecone");
    expect(mocks.scopeSetTag).toHaveBeenCalledWith("rag.operation", "upsert");
    // Grouped by the stable lane id, not the display-name-derived title.
    expect(mocks.scopeSetFingerprint).toHaveBeenCalledWith(["rag", "pinecone"]);
    expect(mocks.scopeSetContext).toHaveBeenCalledWith("rag", expect.objectContaining({
      reason: expect.stringContaining("Pinecone 503 unavailable")
    }));
    consoleError.mockRestore();
  });

  it("does NOT send a provider 429 to Sentry — rate limits page through the usage-limit lane", async () => {
    // db-health's non-RAG alerter has always suppressed 429-shaped text from Sentry (a rate limit
    // is budget/pacing behavior, not a broken integration). This RAG path had no equivalent, so an
    // identical failure paged here and stayed silent everywhere else. The provider_degraded
    // notification and alertUsageLimitHit escalation are unaffected.
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.upsert.mockRejectedValue(new Error("PineconeError: HTTP 429 Too Many Requests"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storeContexts } = await import("../src/lib/vector-db");

    const result = await storeContexts([
      { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);

    expect(result.error).toContain("429");
    // Give the detached alert the same window the 503 case above needs before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.captureMessage).not.toHaveBeenCalledWith("Pinecone connection failed");
    consoleError.mockRestore();
  });
});

// ── R17: fix train/serve text skew (VECTOR_EMBED_CLEAN_TEXT) ────────────────

describe("R17: VECTOR_EMBED_CLEAN_TEXT — embed clean text, store boilerplate-prefixed text unchanged", () => {
  it("default OFF: embeds the [Published: ...] boilerplate-prefixed text (current behavior)", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([{ text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }]);

    expect(mocks.embed).toHaveBeenCalledWith(
      expect.objectContaining({ input: ["[Published: 2026-06-18] AAPL 8-K details"] })
    );
    // The stored/upserted metadata text also carries the prefix (citation display, unaffected either way).
    const record = mocks.upsert.mock.calls[0][0].records[0];
    expect(record.metadata.text).toBe("[Published: 2026-06-18] AAPL 8-K details");
  });

  it("when ON: embeds CLEAN text (prefix stripped) but stores the boilerplate-prefixed text unchanged", async () => {
    process.env.VECTOR_EMBED_CLEAN_TEXT = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([{ text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }]);

    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ input: ["AAPL 8-K details"] }));
    // Stored/cited text is UNCHANGED — still carries the [Published:] prefix for citation display.
    const record = mocks.upsert.mock.calls[0][0].records[0];
    expect(record.metadata.text).toBe("[Published: 2026-06-18] AAPL 8-K details");
    delete process.env.VECTOR_EMBED_CLEAN_TEXT;
  });

  it("when ON: a chunk with no [Published:] prefix (e.g. no timestamp) embeds unchanged", async () => {
    process.env.VECTOR_EMBED_CLEAN_TEXT = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([{ text: "some context header\n\nbody text", metadata: { symbol: "AAPL", source: "sec-10k", timestamp: "" } }]);

    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ input: ["some context header\n\nbody text"] }));
    delete process.env.VECTOR_EMBED_CLEAN_TEXT;
  });
});

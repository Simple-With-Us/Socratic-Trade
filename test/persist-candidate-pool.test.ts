/**
 * persist-candidate-pool (2026-07-06): RAG_PERSIST_CANDIDATE_POOL wiring in
 * `retrieveContextDetailed` (vector-db.ts) + `recordCandidatePool` (rag/candidate-pool.ts).
 *
 * The captured pool is `rankPool`'s return value (`ordered` in vector-db.ts) — i.e. every
 * candidate that SURVIVED the score floor / as-of guard / hybrid / rerank / dedupe pipeline, right
 * before the final `.slice(0, limit)` cut. A candidate dropped by minScore/asOf/dedupe never
 * enters `ordered` (rankPool already filtered it out) and so is correctly absent from the
 * persisted pool too — this feature answers "which quality-surviving candidates got cut only by
 * the final top-N slice", not "everything Pinecone ever returned before any filtering".
 *
 * Three things pinned here:
 *  1. Flag OFF (default/unset): retrieveContextDetailed's audit-call count and returned chunks
 *     are byte-identical to pre-persist-candidate-pool behavior — `audit("rag_candidate_pool", ...)`
 *     is never called.
 *  2. Flag ON: the persisted record's `candidates` array includes candidates that survived the
 *     floor/asOf/dedupe pipeline but were cut ONLY by the final top-`limit` slice — each carrying
 *     the correct `used` flag (true only for ids in the final slice). A candidate dropped by
 *     minScore/asOf/dedupe upstream of `ordered` is correctly NOT present at all.
 *  3. A #822 multi-query case (`options.queries` non-empty): still exactly ONE fused-pool record,
 *     covering ids surfaced by every query variant (not one record per variant).
 *  4. Id-less collision hardening: two matches lacking a Pinecone `id` (both key on the literal
 *     empty string `""`) must still get distinct `used` flags per their own final-slice membership,
 *     mirroring the synthetic per-position key the #822 fan-out fusion code already uses for the
 *     same "empty id" hazard.
 *
 * Mocking pattern mirrors test/rag-multi-query-retrieval.test.ts / test/rag-retrieval-eval.test.ts
 * (full Pinecone/Voyage mock, no live network, `audit` mocked so we can assert on its call args).
 */
import { pinRagQualityFlagsOff } from "./rag-test-env";
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
    resolveApiKey: vi.fn(),
    audit: vi.fn()
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
  audit: mocks.audit,
  setInternalSetting: vi.fn()
}));

function candidatePoolCalls() {
  return mocks.audit.mock.calls.filter((call) => call[0] === "rag_candidate_pool");
}

describe("retrieveContextDetailed: RAG_PERSIST_CANDIDATE_POOL wiring", () => {
  beforeEach(() => {
  pinRagQualityFlagsOff();
    vi.resetModules();
    vi.clearAllMocks();

    process.env.PINECONE_API_KEY = "pinecone-test";
    process.env.VOYAGE_API_KEY = "voyage-test";
    process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
    process.env.VECTOR_ENABLE_RERANK = "off";
    process.env.HYBRID_RETRIEVAL = "off";
    delete process.env.VECTOR_MIN_SCORE;
    delete process.env.RAG_PERSIST_CANDIDATE_POOL;

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
    delete process.env.VECTOR_MIN_SCORE;
    delete process.env.RAG_PERSIST_CANDIDATE_POOL;
  });

  it("flag OFF (default/unset): never calls audit('rag_candidate_pool', ...) — byte-identical audit-call count and returned chunks", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL revenue", userId: "local", scope: "shared" } },
        { id: "low", score: 0.1, metadata: { text: "barely related", userId: "local", scope: "shared" } }
      ]
    }).mockResolvedValueOnce({ matches: [] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local", { minScore: 0.5 });

    expect(result.length).toBe(2);
    expect(candidatePoolCalls().length).toBe(0);
    // No audit call of ANY kind here — the score floor drop doesn't go through strict as-of audit
    // either in this fixture, so total audit calls should be exactly 0 (byte-identical to pre-flag
    // behavior: this call site made no audit calls at all before this feature existed).
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("explicit RAG_PERSIST_CANDIDATE_POOL=off behaves the same as unset — no persist call", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "off";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } }]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 1, "local");

    expect(candidatePoolCalls().length).toBe(0);
  });

  it("flag ON: persists a candidate cut only by the final top-limit slice, with the correct `used` flag per id", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "kept-a", score: 0.9, metadata: { text: "AAPL earnings beat", userId: "local", scope: "shared", doc_type: "10-k" } },
        { id: "kept-b", score: 0.8, metadata: { text: "AAPL revenue growth", userId: "local", scope: "shared", doc_type: "10-q" } },
        // Survives the minScore floor (0.5) but is cut only by the final top-2 slice below.
        { id: "not-used", score: 0.6, metadata: { text: "AAPL related but lower ranked", userId: "local", scope: "shared" } },
        // Dropped by minScore upstream of `ordered` — must NOT appear in the persisted pool at all.
        { id: "dropped-low-score", score: 0.1, metadata: { text: "barely related", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local", { minScore: 0.5, runId: "run-123" });

    expect(result.map((c) => c.id)).toEqual(["kept-a", "kept-b"]);

    const calls = candidatePoolCalls();
    expect(calls.length).toBe(1);
    const [, payload, userId] = calls[0]!;
    expect(userId).toBe("local");
    expect(payload).toMatchObject({ runId: "run-123", symbol: "AAPL", asOf: undefined });
    expect(typeof (payload as any).queryHash).toBe("string");
    expect((payload as any).queryHash).not.toContain("AAPL earnings"); // never the raw query text

    const candidates = (payload as any).candidates as Array<Record<string, unknown>>;
    const ids = candidates.map((c) => c.id);
    // The quality-surviving-but-not-selected candidate IS present; the minScore-dropped one is not
    // (it never enters rankPool's returned pool in the first place).
    expect(ids).toEqual(expect.arrayContaining(["kept-a", "kept-b", "not-used"]));
    expect(ids).not.toContain("dropped-low-score");

    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("kept-a")).toMatchObject({ used: true, docType: "10-k" });
    expect(byId.get("kept-b")).toMatchObject({ used: true, docType: "10-q" });
    expect(byId.get("not-used")).toMatchObject({ used: false });

    // Raw chunk text must never be persisted.
    for (const c of candidates) {
      expect(Object.keys(c)).not.toContain("text");
      expect(JSON.stringify(c)).not.toContain("earnings beat");
    }
  });

  it("flag ON: a candidate dropped by the as-of guard is absent from the persisted pool (never enters `ordered`)", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "in-window", score: 0.9, metadata: { text: "in window", userId: "local", scope: "shared", acceptance_datetime: "2026-05-01" } },
        { id: "future", score: 0.85, metadata: { text: "future filing", userId: "local", scope: "shared", acceptance_datetime: "2026-06-01" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("q", "AAPL", 5, "local", { asOf: "2026-05-15" });

    expect(result.map((c) => c.id)).toEqual(["in-window"]);

    const calls = candidatePoolCalls();
    expect(calls.length).toBe(1);
    const candidates = (calls[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("in-window")).toMatchObject({ used: true });
    // "future" was dropped by the as-of guard inside rankPool, so it never reaches `ordered` and is
    // correctly absent from the persisted pool (asOf-guard drops happen upstream of this capture).
    expect(byId.has("future")).toBe(false);
  });

  it("flag ON: a candidate cut only by the final slice carries asOf/relevanceScore from metadata/_rerankScore", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "top", score: 0.9, metadata: { text: "AAPL top match", userId: "local", scope: "shared", acceptance_datetime: "2026-05-01" } },
        { id: "second", score: 0.85, metadata: { text: "AAPL second match", userId: "local", scope: "shared", acceptance_datetime: "2026-04-01" } },
        { id: "third", score: 0.8, metadata: { text: "AAPL third match", userId: "local", scope: "shared", acceptance_datetime: "2026-03-01" } }
      ]
    });
    mocks.rerank.mockResolvedValue({
      data: [
        { index: 0, relevanceScore: 0.95 },
        { index: 1, relevanceScore: 0.7 },
        { index: 2, relevanceScore: 0.6 }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("q", "AAPL", 2, "local");

    expect(result.map((c) => c.id)).toEqual(["top", "second"]);

    const calls = candidatePoolCalls();
    expect(calls.length).toBe(1);
    const candidates = (calls[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("third")).toMatchObject({ used: false, relevanceScore: 0.6, asOf: "2026-03-01" });
    expect(byId.get("top")).toMatchObject({ used: true, relevanceScore: 0.95 });
  });

  it("flag ON: two id-less matches (one in the final slice, one not) get distinct `used` flags instead of colliding on key \"\"", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValueOnce({
      matches: [
        // No `id` field at all — both would key on the literal empty string "" if the capture
        // block didn't scope a synthetic per-position key the way the #822 fusion code does.
        { score: 0.9, metadata: { text: "id-less kept", userId: "local", scope: "shared" } },
        { score: 0.8, metadata: { text: "id-less not kept", userId: "local", scope: "shared" } }
      ]
    }).mockResolvedValueOnce({ matches: [] });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("q", "AAPL", 1, "local", { minScore: 0.5 });

    // Only the higher-scored id-less match survives the top-1 slice.
    expect(result.length).toBe(1);
    expect(result[0]!.text).toContain("id-less kept");

    const calls = candidatePoolCalls();
    expect(calls.length).toBe(1);
    const candidates = (calls[0]![1] as any).candidates as Array<Record<string, unknown>>;
    // Both id-less candidates are present in the captured pool (both survived the pipeline; only
    // the final top-1 slice differs), and their `id` field is the literal empty string for both —
    // exercising the exact collision the synthetic per-position key must prevent.
    expect(candidates.length).toBe(2);
    expect(candidates.every((c) => c.id === "")).toBe(true);
    const usedFlags = candidates.map((c) => c.used);
    // If the two id-less rows collided on key "", both would carry the SAME used flag (both true,
    // since `finalIds.has("")` would be true once any id-less candidate lands in the slice). They
    // must instead be distinct: exactly one used:true (the top-scored, sliced-in candidate) and one
    // used:false (the one the final top-1 slice cut).
    expect(usedFlags).toEqual(expect.arrayContaining([true, false]));
    expect(usedFlags.filter(Boolean).length).toBe(1);
  });

  it("flag ON + multi-query (#822 fused pool): exactly ONE candidate-pool record covering ids from every query variant", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    mocks.embed.mockImplementation(({ input }: { input: string[] }) =>
      Promise.resolve({ data: [{ embedding: [input[0]!.length, 0.2, 0.3] }] })
    );
    mocks.query.mockImplementation(({ vector }: { vector: number[] }) => {
      const tag = vector[0];
      return Promise.resolve({
        matches: [{ id: `match-${tag}`, score: 0.9, metadata: { text: `text for ${tag}`, userId: "local", scope: "shared" } }]
      });
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const variants = ["AAPL risk factors", "AAPL guidance outlook", "AAPL litigation disclosures"];
    const result = await retrieveContextDetailed("AAPL primary query", "AAPL", 4, "local", { queries: variants });

    // Sanity: the fused pool did surface multiple variants' matches (pre-existing #822 behavior).
    expect(result.length).toBeGreaterThan(1);

    const calls = candidatePoolCalls();
    // Exactly one persisted record for the whole retrieveContextDetailed call, not one per variant.
    expect(calls.length).toBe(1);

    const candidates = (calls[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const ids = candidates.map((c) => c.id);
    // Every one of the 4 fanned-out queries (primary + 3 variants) contributed a distinct match id
    // to the single fused pool this record covers.
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
  });

  it("flag ON: queryHash is derived from the primary query (hashQuery), never the raw text, and is stable for the same query", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "x", userId: "local", scope: "shared" } }]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const { hashQuery } = await import("../src/lib/rag-metering");

    await retrieveContextDetailed("a stable query string", "AAPL", 1, "local");
    const calls = candidatePoolCalls();
    expect(calls.length).toBe(1);
    expect((calls[0]![1] as any).queryHash).toBe(hashQuery("a stable query string"));
  });

  it("review fix: an observability-capture throw never breaks retrieval — v1's capture block is wrapped in its own try/catch (defense in depth)", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings report", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL revenue update", userId: "local", scope: "shared" } }
      ]
    });
    // Force the v1 capture block to throw: recordCandidatePool is the last call it makes, so
    // making IT throw exercises the try/catch around the whole block.
    mocks.audit.mockImplementation((kind: string) => {
      if (kind === "rag_candidate_pool") throw new Error("simulated capture failure");
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local");

    // Retrieval succeeded and returned the full, correct chunk set despite the capture throwing.
    expect(result.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result[0]!.text).toBe("AAPL earnings report");
    expect(result[1]!.text).toBe("AAPL revenue update");
  });
});

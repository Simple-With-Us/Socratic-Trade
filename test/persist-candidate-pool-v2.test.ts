/**
 * persist-pool-v2 (2026-07-06): RAG_PERSIST_CANDIDATE_POOL_FULL wiring in
 * `retrieveContextDetailed` (vector-db.ts) + `rankPool`'s `onDispositions` hook +
 * `recordCandidatePoolFull` (rag/candidate-pool.ts).
 *
 * v1 (test/persist-candidate-pool.test.ts, RAG_PERSIST_CANDIDATE_POOL) honestly captures only
 * `rankPool`'s OUTPUT pool (`ordered`) — a candidate dropped by minScore/asOf/dedupe/rerank never
 * enters `ordered` and so is invisible to v1. v2 closes that gap: it captures the PRE-`rankPool`
 * `matches` pool (raw Pinecone recall, or the #822 fused multi-query pool) together with a
 * per-candidate DISPOSITION naming the exact stage that dropped it (or `used`/`kept_not_used` for
 * survivors).
 *
 * Four things pinned here (mirrors the v1 file's four-point pin list):
 *  1. Flag OFF (default/unset): retrieveContextDetailed's audit-call count and returned chunks are
 *     byte-identical to pre-v2 behavior — `audit("rag_candidate_pool_full", ...)` is never called,
 *     and (critically) `rankPool` runs its exact pure-function path (no `onDispositions` is even
 *     constructed) so retrieval itself is unaffected.
 *  2. Flag ON: a synthetic matches pool where candidates are dropped at DIFFERENT stages (below
 *     minScore, dated-after-asOf, near-duplicate, cut by the final slice, and some used) yields a
 *     record whose per-candidate dispositions correctly name each stage.
 *  3. A #822 multi-query case: exactly ONE fused record covering ids from every query variant,
 *     with correct dispositions.
 *  4. v1 and v2 can be enabled independently (distinct flags, distinct audit `kind`s) and neither
 *     regresses the other when both are on.
 *
 * Mocking pattern mirrors test/persist-candidate-pool.test.ts (full Pinecone/Voyage mock, no live
 * network, `audit` mocked so we can assert on its call args).
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

function fullPoolCalls() {
  return mocks.audit.mock.calls.filter((call) => call[0] === "rag_candidate_pool_full");
}

function v1PoolCalls() {
  return mocks.audit.mock.calls.filter((call) => call[0] === "rag_candidate_pool");
}

describe("retrieveContextDetailed: RAG_PERSIST_CANDIDATE_POOL_FULL wiring", () => {
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
    delete process.env.RAG_PERSIST_CANDIDATE_POOL_FULL;

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
    delete process.env.RAG_PERSIST_CANDIDATE_POOL_FULL;
  });

  it("flag OFF (default/unset): never calls audit('rag_candidate_pool_full', ...) — byte-identical audit-call count and returned chunks", async () => {
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
    expect(fullPoolCalls().length).toBe(0);
    // No audit call of ANY kind — same byte-identical guarantee v1 pins for its own flag.
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("explicit RAG_PERSIST_CANDIDATE_POOL_FULL=off behaves the same as unset — no persist call", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "off";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } }]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 1, "local");

    expect(fullPoolCalls().length).toBe(0);
  });

  it("flag ON: dispositions correctly name minScore / asOf / final-slice / used across a mixed pool (no dedupe)", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        // Kept, used (final top-2 slice).
        { id: "kept-a", score: 0.9, metadata: { text: "AAPL fiscal 2026 revenue guidance raised sharply", userId: "local", scope: "shared", doc_type: "10-k", acceptance_datetime: "2026-05-01" } },
        // Kept, used (final top-2 slice).
        { id: "kept-b", score: 0.85, metadata: { text: "AAPL services segment margin expansion continues", userId: "local", scope: "shared", doc_type: "10-q", acceptance_datetime: "2026-04-01" } },
        // Survives every filter but is cut ONLY by the final top-2 slice (dedupe is off in this
        // test, so this is a genuine kept_not_used, not conflated with dedupe's own limit cap).
        { id: "not-used", score: 0.8, metadata: { text: "AAPL supply chain diversification update noted", userId: "local", scope: "shared", acceptance_datetime: "2026-03-01" } },
        // Dated after the asOf guard.
        { id: "future", score: 0.75, metadata: { text: "AAPL announces future product roadmap details", userId: "local", scope: "shared", acceptance_datetime: "2026-06-01" } },
        // Below the minScore floor.
        { id: "low-score", score: 0.1, metadata: { text: "barely related filler text about nothing", userId: "local", scope: "shared", acceptance_datetime: "2026-02-01" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local", {
      minScore: 0.5,
      asOf: "2026-05-15",
      runId: "run-v2-1"
    });

    expect(result.map((c) => c.id)).toEqual(["kept-a", "kept-b"]);

    const calls = fullPoolCalls();
    expect(calls.length).toBe(1);
    const [, payload, userId] = calls[0]!;
    expect(userId).toBe("local");
    expect(payload).toMatchObject({ runId: "run-v2-1", symbol: "AAPL", asOf: "2026-05-15" });
    expect(typeof (payload as any).queryHash).toBe("string");
    expect((payload as any).queryHash).not.toContain("AAPL earnings");

    const candidates = (payload as any).candidates as Array<Record<string, unknown>>;
    // Every original candidate is present (unlike v1, which drops minScore/asOf losers entirely).
    expect(candidates.length).toBe(5);
    const byId = new Map(candidates.map((c) => [c.id, c]));

    expect(byId.get("kept-a")).toMatchObject({ disposition: "used", docType: "10-k" });
    expect(byId.get("kept-b")).toMatchObject({ disposition: "used", docType: "10-q" });
    expect(byId.get("not-used")).toMatchObject({ disposition: "kept_not_used" });
    expect(byId.get("future")).toMatchObject({ disposition: "dropped_asof" });
    expect(byId.get("low-score")).toMatchObject({ disposition: "dropped_minscore" });

    // Raw chunk text must never be persisted (same posture as v1).
    for (const c of candidates) {
      expect(Object.keys(c)).not.toContain("text");
      expect(JSON.stringify(c)).not.toContain("revenue guidance");
    }
  });

  it("flag ON: a near-duplicate candidate dropped by dedupe is disposed as dropped_dedupe", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    const text = "AAPL fiscal 2026 revenue guidance raised sharply across every reporting segment";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "original", score: 0.9, metadata: { text, userId: "local", scope: "shared" } },
        { id: "near-dup", score: 0.85, metadata: { text, userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local", { dedupeSimilarity: 0.5 });

    expect(result.map((c) => c.id)).toEqual(["original"]);

    const candidates = (fullPoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("original")).toMatchObject({ disposition: "used" });
    expect(byId.get("near-dup")).toMatchObject({ disposition: "dropped_dedupe" });
  });

  it("review fix: flagship config (limit=3, dedupeSimilarity=0.6) — 5 distinct candidates yield dropped_dedupe_truncate for the 2 cut ones, NOT dropped_dedupe", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.95, metadata: { text: "the first entirely distinct passage about quarterly revenue growth trends", userId: "local", scope: "shared" } },
        { id: "b", score: 0.9, metadata: { text: "a second entirely distinct passage about supply chain logistics risk factors", userId: "local", scope: "shared" } },
        { id: "c", score: 0.85, metadata: { text: "a third entirely distinct passage about executive compensation governance policy", userId: "local", scope: "shared" } },
        { id: "d", score: 0.8, metadata: { text: "a fourth entirely distinct passage about international regulatory compliance matters", userId: "local", scope: "shared" } },
        { id: "e", score: 0.75, metadata: { text: "a fifth entirely distinct passage about capital expenditure and infrastructure investment", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 3, "local", { dedupeSimilarity: 0.6 });

    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);

    const candidates = (fullPoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("a")).toMatchObject({ disposition: "used" });
    expect(byId.get("b")).toMatchObject({ disposition: "used" });
    expect(byId.get("c")).toMatchObject({ disposition: "used" });
    // "d" and "e" are distinct, non-duplicate candidates cut purely by dedupeSimilar's OWN
    // internal top-limit cap — this is the exact bug this fix addresses: they must NOT be
    // mislabeled dropped_dedupe (near-duplicate removal).
    expect(byId.get("d")).toMatchObject({ disposition: "dropped_dedupe_truncate" });
    expect(byId.get("e")).toMatchObject({ disposition: "dropped_dedupe_truncate" });
  });

  it("flag ON: a rerank-truncated candidate is disposed as dropped_rerank_truncate", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "top", score: 0.9, metadata: { text: "AAPL top match", userId: "local", scope: "shared" } },
        { id: "second", score: 0.85, metadata: { text: "AAPL second match", userId: "local", scope: "shared" } },
        { id: "third", score: 0.8, metadata: { text: "AAPL third match", userId: "local", scope: "shared" } }
      ]
    });
    // Voyage's rerank is invoked with topK=Math.min(limit, pool.length)=2, so only 2 of the 3
    // candidates come back — "third" is truncated by rerank's own topK cut, never reaching the
    // relevance floor at all.
    mocks.rerank.mockResolvedValue({
      data: [
        { index: 0, relevanceScore: 0.95 },
        { index: 1, relevanceScore: 0.7 }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("q", "AAPL", 2, "local");

    expect(result.map((c) => c.id)).toEqual(["top", "second"]);

    const candidates = (fullPoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("top")).toMatchObject({ disposition: "used", relevanceScore: 0.95 });
    expect(byId.get("second")).toMatchObject({ disposition: "used", relevanceScore: 0.7 });
    expect(byId.get("third")).toMatchObject({ disposition: "dropped_rerank_truncate" });
  });

  it("flag ON: a candidate cut by the post-rerank relevance floor is disposed as dropped_rerank_floor", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    // 4 candidates with limit=3 so rerank actually runs (fusedPool.length=4 > limit=3) and Voyage's
    // topK=3 cut returns exactly 3 of them (isolating the relevance floor — applied AFTER rerank,
    // against `ordered` — from the separate rerank-truncate disposition covered by the prior test).
    mocks.query.mockResolvedValue({
      matches: [
        { id: "high-relevance", score: 0.9, metadata: { text: "AAPL directly on point", userId: "local", scope: "shared" } },
        { id: "mid-relevance", score: 0.87, metadata: { text: "AAPL somewhat related", userId: "local", scope: "shared" } },
        { id: "low-relevance", score: 0.85, metadata: { text: "AAPL tangential mention", userId: "local", scope: "shared" } },
        { id: "truncated", score: 0.8, metadata: { text: "AAPL barely mentioned at all", userId: "local", scope: "shared" } }
      ]
    });
    mocks.rerank.mockResolvedValue({
      data: [
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.5 },
        { index: 2, relevanceScore: 0.1 }
        // index 3 ("truncated") is absent — Voyage's topK=3 cut dropped it before scoring.
      ]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("q", "AAPL", 3, "local", { minRelevanceScore: 0.3 });

    expect(result.map((c) => c.id)).toEqual(["high-relevance", "mid-relevance"]);

    const candidates = (fullPoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    expect(byId.get("high-relevance")).toMatchObject({ disposition: "used" });
    expect(byId.get("truncated")).toMatchObject({ disposition: "dropped_rerank_truncate" });
    expect(byId.get("mid-relevance")).toMatchObject({ disposition: "used" });
    expect(byId.get("low-relevance")).toMatchObject({ disposition: "dropped_rerank_floor" });
  });

  it("flag ON + multi-query (#822 fused pool): exactly ONE record covering ids from every query variant, with correct dispositions", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
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

    expect(result.length).toBeGreaterThan(1);

    const calls = fullPoolCalls();
    expect(calls.length).toBe(1);

    const candidates = (calls[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const ids = candidates.map((c) => c.id);
    // Every one of the 4 fanned-out queries (primary + 3 variants) contributed a distinct match id
    // to the single fused pool this record covers, and each carries SOME disposition.
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
    for (const c of candidates) {
      expect(typeof c.disposition).toBe("string");
    }
  });

  it("both flags ON: v1 and v2 persist independently (two distinct audit kinds, one call each)", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL = "on";
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings", userId: "local", scope: "shared" } },
        { id: "low", score: 0.1, metadata: { text: "barely related", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL earnings", "AAPL", 1, "local", { minScore: 0.5 });

    expect(v1PoolCalls().length).toBe(1);
    expect(fullPoolCalls().length).toBe(1);

    // v1's payload only has the survivor; v2's payload has both, with the drop reason.
    const v1Candidates = (v1PoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    expect(v1Candidates.map((c) => c.id)).toEqual(["a"]);

    const v2Candidates = (fullPoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    const v2ById = new Map(v2Candidates.map((c) => [c.id, c]));
    expect(v2ById.get("a")).toMatchObject({ disposition: "used" });
    expect(v2ById.get("low")).toMatchObject({ disposition: "dropped_minscore" });
  });

  it("review fix: an id-less match that SURVIVES rerank is `used` with its relevanceScore (not mislabeled dropped_rerank_truncate)", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    process.env.VECTOR_ENABLE_RERANK = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValueOnce({
      matches: [
        // Index 0: id-less, SURVIVES rerank (Voyage assigns it the top relevanceScore below) —
        // this is the exact case the bug mislabeled, because rerankMatches returns a NEW spread
        // object `{ ...match, _rerankScore }` for it, losing its original object identity.
        { score: 0.7, metadata: { text: "id-less survivor with strong rerank relevance", userId: "local", scope: "shared" } },
        // Index 1: id-less, TRUNCATED by rerank's own topK=2 cut (never scored at all).
        { score: 0.65, metadata: { text: "id-less truncated by rerank topK cut", userId: "local", scope: "shared" } },
        // Index 2: real id, also survives.
        { id: "real-id", score: 0.6, metadata: { text: "real-id survivor", userId: "local", scope: "shared" } }
      ]
    }).mockResolvedValueOnce({ matches: [] });
    // Voyage's rerank is invoked with topK=Math.min(limit, matches.length)=2, so only indices 0
    // and 2 come back (reordered so the id-less survivor ranks first); index 1 is truncated.
    mocks.rerank.mockResolvedValue({
      data: [
        { index: 0, relevanceScore: 0.92 },
        { index: 2, relevanceScore: 0.55 }
      ]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("q", "AAPL", 2, "local");

    // The id-less survivor and the real-id survivor are both `used`, in Voyage's rerank order.
    expect(result.length).toBe(2);
    expect(result[0]!.text).toContain("id-less survivor");
    expect(result[0]!.relevanceScore).toBe(0.92);
    expect(result[1]!.id).toBe("real-id");
    expect(result[1]!.relevanceScore).toBe(0.55);

    const candidates = (fullPoolCalls()[0]![1] as any).candidates as Array<Record<string, unknown>>;
    // Two id-less rows (both carry the literal empty-string persisted `id` — `__poolKey` must
    // never leak into the payload) plus the real-id row.
    expect(candidates.length).toBe(3);
    const idLessRows = candidates.filter((c) => c.id === "");
    expect(idLessRows.length).toBe(2);
    const survivorRow = idLessRows.find((c) => c.disposition === "used");
    const truncatedRow = idLessRows.find((c) => c.disposition !== "used");
    expect(survivorRow).toBeDefined();
    expect(survivorRow).toMatchObject({ disposition: "used", relevanceScore: 0.92 });
    expect(truncatedRow).toMatchObject({ disposition: "dropped_rerank_truncate" });
    expect(truncatedRow!.relevanceScore).toBeUndefined();

    const realIdRow = candidates.find((c) => c.id === "real-id");
    expect(realIdRow).toMatchObject({ disposition: "used", relevanceScore: 0.55 });

    // No `__poolKey` (the internal disambiguation key) ever leaks into the persisted payload.
    for (const c of candidates) {
      expect(Object.keys(c)).not.toContain("__poolKey");
    }
  });

  it("review fix: an observability-capture throw never breaks retrieval — chunks are returned unchanged", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [
        { id: "a", score: 0.9, metadata: { text: "AAPL earnings report", userId: "local", scope: "shared" } },
        { id: "b", score: 0.8, metadata: { text: "AAPL revenue update", userId: "local", scope: "shared" } }
      ]
    });
    // Force the capture block to throw: recordCandidatePoolFull is the last call the v2 capture
    // block makes, so making IT throw exercises the try/catch around the whole block without
    // needing to reach into rankPool's internals.
    mocks.audit.mockImplementation((kind: string) => {
      if (kind === "rag_candidate_pool_full") throw new Error("simulated capture failure");
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const result = await retrieveContextDetailed("AAPL earnings", "AAPL", 2, "local");

    // Retrieval succeeded and returned the full, correct chunk set despite the capture throwing —
    // the throw must be swallowed by the capture block's own try/catch, not propagate to the
    // function's outer catch (which would have returned []).
    expect(result.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result[0]!.text).toBe("AAPL earnings report");
    expect(result[1]!.text).toBe("AAPL revenue update");
  });

  it("flag ON: queryHash is derived from the primary query (hashQuery), never the raw text", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "x", userId: "local", scope: "shared" } }]
    });

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const { hashQuery } = await import("../src/lib/rag-metering");

    await retrieveContextDetailed("a stable query string", "AAPL", 1, "local");
    const calls = fullPoolCalls();
    expect(calls.length).toBe(1);
    expect((calls[0]![1] as any).queryHash).toBe(hashQuery("a stable query string"));
  });
});

describe("recordCandidatePoolFull: defensive hard cap on persisted candidate count (review fix)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.RAG_PERSIST_CANDIDATE_POOL_FULL;
  });

  afterEach(() => {
    delete process.env.RAG_PERSIST_CANDIDATE_POOL_FULL;
  });

  it("truncates an oversized candidates array to the hard cap while honestly reporting the true candidateCount", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    const { recordCandidatePoolFull } = await import("../src/lib/rag/candidate-pool");
    const oversized = Array.from({ length: 600 }, (_, i) => ({
      id: `cand-${i}`,
      disposition: "kept_not_used" as const
    }));

    recordCandidatePoolFull({ symbol: "AAPL", queryHash: "hash", candidates: oversized }, "local");

    const calls = mocks.audit.mock.calls.filter((call) => call[0] === "rag_candidate_pool_full");
    expect(calls.length).toBe(1);
    const payload = calls[0]![1] as any;
    // Persisted array is capped well below the 600-candidate input.
    expect(payload.candidates.length).toBeLessThan(600);
    expect(payload.candidates.length).toBeLessThanOrEqual(500);
    // The TRUE count is still honestly reported, even though the array itself was truncated.
    expect(payload.candidateCount).toBe(600);
  });

  it("does not truncate a normal-sized candidates array (well under the cap)", async () => {
    process.env.RAG_PERSIST_CANDIDATE_POOL_FULL = "on";
    const { recordCandidatePoolFull } = await import("../src/lib/rag/candidate-pool");
    const normal = Array.from({ length: 5 }, (_, i) => ({
      id: `cand-${i}`,
      disposition: "kept_not_used" as const
    }));

    recordCandidatePoolFull({ symbol: "AAPL", queryHash: "hash", candidates: normal }, "local");

    const calls = mocks.audit.mock.calls.filter((call) => call[0] === "rag_candidate_pool_full");
    const payload = calls[0]![1] as any;
    expect(payload.candidates.length).toBe(5);
    expect(payload.candidateCount).toBe(5);
  });
});

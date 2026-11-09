/**
 * Rerank candidate-pool cap (2026-07-04 RAG quick-wins, composite review "raise the rerank
 * candidate-pool cap"): `overFetchK` used to hard-cap EVERY over-fetch path (rerank, hybrid, as-of)
 * at 50 candidates, even though Voyage's `rerank-2.5` cross-encoder is cheap to run over
 * hundreds-to-1000 candidates — so a flip-the-decision chunk buried at dense rank 51+ never
 * reached the reranker for a mega-cap symbol with a full 10-K plus many 8-Ks.
 *
 * `rerankOverFetchK` widens ONLY the pool actually handed to reranking (env-tunable via
 * VECTOR_RERANK_OVERFETCH_K, default 150); the non-rerank over-fetch paths (as-of-only, hybrid
 * without rerank) keep the original modest `overFetchK` cap unchanged.
 *
 * Full-mock integration pattern mirrors test/vector-db-rerank-floor.test.ts.
 */
import { pinRagQualityFlagsOff } from "./rag-test-env";
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
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "on";
  delete process.env.HYBRID_RETRIEVAL;
  delete process.env.VECTOR_MIN_SCORE;
  delete process.env.VECTOR_RERANK_OVERFETCH_K;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  mocks.query.mockResolvedValue({ matches: [] });
  mocks.rerank.mockResolvedValue({ data: [] });
});

describe("retrieveContextDetailed: rerank-path over-fetch cap", () => {
  it("requests topK=150 (the new default) from Pinecone when rerank will run, not the old 50 cap", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("query", "AAPL", 3, "local");

    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ topK: 150 }));
  });

  it("is env-tunable via VECTOR_RERANK_OVERFETCH_K", async () => {
    process.env.VECTOR_RERANK_OVERFETCH_K = "200";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("query", "AAPL", 3, "local");

    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ topK: 200 }));
  });

  it("never fetches fewer than the requested limit even if the cap is tuned below it", async () => {
    process.env.VECTOR_RERANK_OVERFETCH_K = "1";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("query", "AAPL", 5, "local");

    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ topK: 5 }));
  });

  it("keeps the original modest overFetchK cap (<=50) for non-rerank paths (as-of only, rerank off)", async () => {
    process.env.VECTOR_ENABLE_RERANK = "off";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("query", "AAPL", 3, "local", { asOf: "2026-07-01T00:00:00Z" });

    // overFetchK(3) = min(max(3*5,3),50) = 15 — unaffected by the rerank-path cap raise.
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ topK: 15 }));
  });
});

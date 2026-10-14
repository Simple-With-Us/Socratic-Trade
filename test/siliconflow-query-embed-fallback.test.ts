/**
 * OpenRouter query-embed rescue.  The primary client fails, SiliconFlow returns a documented
 * envelope (extra keys included), and the embed stage is closed once as a success attributed
 * to SiliconFlow.  A missing SiliconFlow key still degrades as lookup_failed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievalTraceSnapshot } from "../src/lib/rag/retrieval-stage-telemetry";

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
  setInternalSetting: vi.fn(),
  getInternalSetting: vi.fn()
}));

vi.mock("../src/lib/rag/corpus-wide-lexical", () => ({
  searchCorpusWideLexicalCandidatesOffLoop: vi.fn(async () => [])
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.OPENROUTER_API_KEY = "sk-or-test-fallback";
  process.env.SILICONFLOW_API_KEY = "sk-sf-test-fallback";
  process.env.RAG_EMBED_PROVIDER = "openrouter";
  process.env.RAG_VECTOR_READ_BACKEND = "pinecone";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  delete process.env.QDRANT_URL;
  delete process.env.VOYAGE_API_KEY;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return "pinecone-test";
    if (service === "openrouter") return "sk-or-test-fallback";
    if (service === "siliconflow") return process.env.SILICONFLOW_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.query.mockResolvedValue({
    matches: [{ id: "rescued", score: 0.9, metadata: { text: "hello", userId: "local", scope: "shared" } }]
  });
  mocks.embed.mockRejectedValue(Object.assign(new Error("embed provider timed out"), { name: "TimeoutError" }));
});

describe("SiliconFlow query-embed rescue", () => {
  it("uses a passthrough SiliconFlow vector and records one successful embed stage", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/embeddings");
      expect(typeof init?.body).toBe("string");
      return new Response(JSON.stringify({
        object: "list",
        model: "BAAI/bge-m3",
        usage: { prompt_tokens: 4, total_tokens: 4 },
        data: [{ object: "embedding", index: 0, embedding: [0.2, 0.3, 0.4] }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const traces: RetrievalTraceSnapshot[] = [];
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("openrouter timeout rescue", "AAPL", 3, "local", {
      onTrace: (trace) => {
        traces.push(trace);
      }
    });

    expect(chunks.map((chunk) => chunk.id)).toEqual(["rescued"]);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? ""));
    expect(body.model).toBe("BAAI/bge-m3");
    expect(traces).toHaveLength(1);
    const embedStages = traces[0]!.stages.filter((stage) => stage.stage === "query_embed_api");
    expect(embedStages).toHaveLength(1);
    expect(embedStages[0]).toMatchObject({ ok: true, provider: "siliconflow", candidatesOut: 1 });
    expect(embedStages[0]?.errorKind).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("degrades as lookup_failed when SiliconFlow has no usable key", async () => {
    delete process.env.SILICONFLOW_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const statuses: string[] = [];
    const traces: RetrievalTraceSnapshot[] = [];
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("openrouter timeout no rescue key", "AAPL", 3, "local", {
      onStatus: (status) => {
        statuses.push(status);
      },
      onTrace: (trace) => {
        traces.push(trace);
      }
    });
    expect(chunks).toEqual([]);
    expect(statuses).toEqual(["lookup_failed"]);
    expect(fetchMock).not.toHaveBeenCalled();
    const embedStages = traces[0]!.stages.filter((stage) => stage.stage === "query_embed_api");
    expect(embedStages).toHaveLength(1);
    expect(embedStages[0]?.ok).toBe(false);
    vi.unstubAllGlobals();
  });
});

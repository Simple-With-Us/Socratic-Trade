// RAG_EMBED_PROVIDER gate (bge-m3-metering-gate, 2026-07-18). Before this env existed,
// activeEmbeddingModel/activeRerankModel picked the provider purely from key presence
// (OpenRouter > SiliconFlow > Voyage) — so setting OPENROUTER_API_KEY for an unrelated feature
// silently flipped RAG embeddings to bge-m3 too. RAG_EMBED_PROVIDER lets an operator pin the
// provider explicitly, decoupled from that key-presence side effect. These tests guard:
//   1. Unset -> byte-for-byte identical precedence to before (the default, so nothing changes
//      until the owner opts in).
//   2. Set -> the pin wins over key presence, for BOTH embed and rerank (one env, two selectors).
//   3. A pinned-but-keyless provider throws LOUDLY instead of silently falling back — silently
//      switching provider would read/write the WRONG embedding space (see
//      embeddingSpaceRevisionForModel in vector-db.ts; cosine scores are meaningless across
//      embedding models even at equal dimensionality).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const namespacedIndex = { upsert, query };
  const namespace = vi.fn(() => namespacedIndex);
  const index = vi.fn(() => ({ ...namespacedIndex, namespace }));
  const prepare = vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) }));
  const database = {
    transaction: vi.fn((work: () => unknown) => ({ immediate: () => work() })),
    prepare
  };
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    resolveApiKey: vi.fn(),
    reserveProviderDispatch: vi.fn(() => ({
      admitted: true as const,
      attemptId: "attempt",
      authorityId: "local"
    })),
    markProviderDispatchStarted: vi.fn(),
    settleProviderDispatch: vi.fn(),
    getDb: vi.fn(() => database)
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
    return { embed: mocks.embed, rerank: mocks.rerank };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  getInternalSetting: vi.fn(),
  filterNewDocumentChunks: vi.fn((chunks: unknown[]) => chunks),
  insertDocumentChunks: vi.fn(),
  getDb: mocks.getDb,
  reserveProviderDispatch: mocks.reserveProviderDispatch,
  markProviderDispatchStarted: mocks.markProviderDispatchStarted,
  settleProviderDispatch: mocks.settleProviderDispatch
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.RAG_EMBED_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "openrouter") return process.env.OPENROUTER_API_KEY;
    if (service === "siliconflow") return process.env.SILICONFLOW_API_KEY;
    return undefined;
  });
});

describe("RAG_EMBED_PROVIDER unset: key-presence precedence (default OpenRouter BAAI bge-m3)", () => {
  it("defaults to openrouter when no key is configured", async () => {
    const { activeEmbeddingProvider, activeRerankProvider, activeEmbeddingModel, activeRerankModel } =
      await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("openrouter");
    expect(activeRerankProvider()).toBe("openrouter");
    expect(activeEmbeddingModel()).toBe("baai/bge-m3");
    expect(activeRerankModel()).toBe("cohere/rerank-v3.5");
  });

  it("prefers openrouter over siliconflow when its key is present", async () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.SILICONFLOW_API_KEY = "sf-key";
    const { activeEmbeddingProvider, activeEmbeddingModel, activeRerankModel } = await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("openrouter");
    expect(activeEmbeddingModel()).toBe("baai/bge-m3");
    expect(activeRerankModel()).toBe("cohere/rerank-v3.5");
  });

  it("falls back to siliconflow when only its key is present", async () => {
    process.env.SILICONFLOW_API_KEY = "sf-key";
    const { activeEmbeddingProvider, activeEmbeddingModel } = await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("siliconflow");
    expect(activeEmbeddingModel()).toBe("BAAI/bge-m3");
  });

  it("treats a mock-prefixed key as absent and defaults to openrouter", async () => {
    process.env.OPENROUTER_API_KEY = "mock-openrouter-key";
    const { activeEmbeddingProvider } = await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("openrouter");
  });
});

describe("RAG_EMBED_PROVIDER pinned: overrides key-presence precedence for BOTH embed and rerank", () => {
  it("pins to openrouter when its key is configured", async () => {
    process.env.RAG_EMBED_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "or-key";
    const { activeEmbeddingProvider, activeRerankProvider, activeEmbeddingModel, activeRerankModel } =
      await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("openrouter");
    expect(activeRerankProvider()).toBe("openrouter");
    expect(activeEmbeddingModel()).toBe("baai/bge-m3");
    expect(activeRerankModel()).toBe("cohere/rerank-v3.5");
  });

  it("pins to siliconflow when its key is configured", async () => {
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    process.env.SILICONFLOW_API_KEY = "sf-key";
    const { activeEmbeddingProvider, activeEmbeddingModel } = await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("siliconflow");
    expect(activeEmbeddingModel()).toBe("BAAI/bge-m3");
  });

  it("is case-insensitive and trims whitespace", async () => {
    process.env.RAG_EMBED_PROVIDER = "  OpenRouter  ";
    process.env.OPENROUTER_API_KEY = "or-key";
    const { activeEmbeddingProvider } = await import("../src/lib/vector-db");
    expect(activeEmbeddingProvider()).toBe("openrouter");
  });
});

describe("RAG_EMBED_PROVIDER pinned-but-keyless: loud error, never a silent fallback", () => {
  it("throws when pinned to openrouter but no key is configured", async () => {
    process.env.RAG_EMBED_PROVIDER = "openrouter";
    const { activeEmbeddingProvider } = await import("../src/lib/vector-db");
    expect(() => activeEmbeddingProvider()).toThrow(/RAG_EMBED_PROVIDER is pinned to "openrouter"/);
  });

  it("throws when pinned to siliconflow but only a mock key is configured", async () => {
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    process.env.SILICONFLOW_API_KEY = "mock-siliconflow-key";
    const { activeEmbeddingProvider } = await import("../src/lib/vector-db");
    expect(() => activeEmbeddingProvider()).toThrow(/no siliconflow API key is configured/);
  });

  it("throws for activeRerankProvider too — one env pins both selectors identically", async () => {
    process.env.RAG_EMBED_PROVIDER = "openrouter";
    const { activeRerankProvider } = await import("../src/lib/vector-db");
    expect(() => activeRerankProvider()).toThrow(/RAG_EMBED_PROVIDER is pinned to "openrouter"/);
  });

  it("throws for activeEmbeddingModel/activeRerankModel too, since both derive from the provider", async () => {
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    const { activeEmbeddingModel, activeRerankModel } = await import("../src/lib/vector-db");
    expect(() => activeEmbeddingModel()).toThrow(/RAG_EMBED_PROVIDER is pinned to "siliconflow"/);
    expect(() => activeRerankModel()).toThrow(/RAG_EMBED_PROVIDER is pinned to "siliconflow"/);
  });
});

describe("RAG_EMBED_PROVIDER invalid value", () => {
  it("throws instead of silently ignoring an unrecognized value", async () => {
    process.env.RAG_EMBED_PROVIDER = "bogus-provider";
    const { activeEmbeddingProvider } = await import("../src/lib/vector-db");
    expect(() => activeEmbeddingProvider()).toThrow(/Invalid RAG_EMBED_PROVIDER/);
  });
});

describe("managed embedding credential integrity", () => {
  it("rejects missing and mock placeholders in production while preserving explicit test doubles", async () => {
    const { embeddingCredentialIsUsable } = await import("../src/lib/vector-db");
    expect(embeddingCredentialIsUsable(undefined, false)).toBe(false);
    expect(embeddingCredentialIsUsable(" mock-provider-key ", false)).toBe(false);
    expect(embeddingCredentialIsUsable("real-provider-key", false)).toBe(true);
    expect(embeddingCredentialIsUsable("mock-test-key", true)).toBe(true);
  });
});

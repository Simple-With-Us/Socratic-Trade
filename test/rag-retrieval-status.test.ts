/**
 * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06).
 *
 * `retrieveContextDetailed` already classifies four distinct reasons a retrieval pass can come
 * back empty (or degraded) — budget-skip, missing keys / pipeline error, real zero-match, and a
 * per-run-budget quality degrade — but previously only surfaced them as Sentry-only warning
 * strings. Every caller saw `[]` (or a non-empty result) with no way to tell WHY. This suite drives
 * each classification point through the new `options.onStatus` receipt (and the
 * `retrieveContextDetailedWithStatus` convenience wrapper) and asserts:
 *   1. the status is observable to the caller for each of the five outcomes, and
 *   2. chunk selection is completely unchanged (the receipt is additive-only, never a gate).
 *
 * Network-free: mocks Pinecone/Voyage exactly like test/rag-retrieval-eval.test.ts (hoisted vi.fn
 * clients, no real fetch).
 */
import { pinRagQualityFlagsOff } from "./rag-test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const index = vi.fn(() => ({ query, upsert: vi.fn() }));
  return {
    query,
    index,
    listIndexes: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    /** When false, Voyage client has no rerank method so mock-client rerank admission is off. */
    voyageClientHasRerank: true as boolean,
    resolveApiKey: vi.fn(),
    audit: vi.fn(),
    isOverLlmBudget: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return { listIndexes: mocks.listIndexes, createIndex: vi.fn(), Index: mocks.index };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    const client: { embed: typeof mocks.embed; rerank?: typeof mocks.rerank } = { embed: mocks.embed };
    if (mocks.voyageClientHasRerank) client.rerank = mocks.rerank;
    return client;
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: vi.fn(),
  getInternalSetting: vi.fn()
}));

// P1 fix (2026-09-07): asserts retrieveContextDetailed itself emits the dense-recall-degraded
// signal on a genuine lookup_failed — this is the shared path every production caller uses (see
// test/rag-production-path-contract.test.ts), unlike search-fusion.ts's retrieveFusedContext
// wrapper which has no production caller at all.
const sentryMetricsMocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  recordEmbedFailure: vi.fn()
}));
vi.mock("../src/lib/sentry-metrics", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...sentryMetricsMocks };
});

// Mocked so `budget_skipped` is deterministic without touching the real ledger/DB — every OTHER
// test in this file explicitly sets this back to `false` (the "under budget" default).
vi.mock("../src/lib/llm-budget", () => ({
  isOverLlmBudget: mocks.isOverLlmBudget
}));

const ENV_KEYS = [
  "PINECONE_API_KEY",
  "VOYAGE_API_KEY",
  "PINECONE_INDEX_READY_WAIT_MS",
  "VECTOR_ENABLE_RERANK",
  "RAG_RERANK_PROVIDER",
  "HYBRID_RETRIEVAL",
  "VECTOR_MIN_SCORE",
  "RAG_RUN_BUDGET_ENABLED",
  "RAG_RUN_BUDGET_CEILING",
  "RAG_RUN_BUDGET_WINDOW_MS"
];

function resetEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function freshVectorDb(opts?: { voyageClientHasRerank?: boolean }) {
  vi.resetModules();
  vi.clearAllMocks();
  resetEnv();
  // When false, Voyage client omits rerank so allowMockClient cannot hide missing rerank credentials.
  mocks.voyageClientHasRerank = opts?.voyageClientHasRerank ?? true;
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "off";
  process.env.HYBRID_RETRIEVAL = "off";
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  mocks.isOverLlmBudget.mockReturnValue(false); // "under budget" default; override per-test for budget_skipped
  return import("../src/lib/vector-db");
}

const HEALTHY_MATCH = {
  id: "chunk-1",
  score: 0.9,
  metadata: {
    text: "Q3 revenue grew 12% year over year on strong cloud demand.",
    userId: "local",
    scope: "shared",
    doc_type: "10-q",
    acceptance_datetime: "2026-06-01"
  }
};

describe("typed retrieval-status receipt (RetrievalStatus)", () => {
  beforeEach(() => {
  pinRagQualityFlagsOff();
    resetEnv();
  });
  afterEach(() => {
    resetEnv();
  });

  it("budget_skipped: isOverLlmBudget=true short-circuits before any Voyage/Pinecone call, returns []", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.isOverLlmBudget.mockReturnValue(true);
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks).toEqual([]);
    expect(status).toBe("budget_skipped");
    expect(mocks.embed).not.toHaveBeenCalled(); // no Voyage embed spend
    expect(mocks.query).not.toHaveBeenCalled(); // no Pinecone query spend
    // P2 fix (2026-09-07): a deliberate budget skip is not a provider/lookup failure — must not
    // flood Sentry or inflate the embed-failure metric (a persistently exhausted daily budget
    // would otherwise emit on every retrieval).
    expect(sentryMetricsMocks.logError).not.toHaveBeenCalled();
    expect(sentryMetricsMocks.recordEmbedFailure).not.toHaveBeenCalled();
  });

  it("no_keys -> lookup_failed: missing Pinecone/Voyage key returns [] with status lookup_failed", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.resolveApiKey.mockImplementation(() => undefined); // no keys resolve at all
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks).toEqual([]);
    expect(status).toBe("lookup_failed");
    expect(mocks.query).not.toHaveBeenCalled(); // no Pinecone call was ever attempted
    // P1 fix (2026-09-07): retrieveContextDetailed emits the degraded signal itself, unconditionally
    // (not gated behind the caller supplying its own onStatus) — see reportRetrievalStatus.
    expect(sentryMetricsMocks.recordEmbedFailure).toHaveBeenCalledWith(expect.any(String), "dense-recall-lookup-failed");
    expect(sentryMetricsMocks.logError).toHaveBeenCalledWith(
      "rag.dense_recall_degraded",
      expect.objectContaining({ symbol: "AAPL", userId: "local", reason: "lookup_failed" })
    );
  });

  it("lookup_failed is reported even when the caller omits onStatus entirely", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.resolveApiKey.mockImplementation(() => undefined);
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
    expect(sentryMetricsMocks.logError).toHaveBeenCalledWith(
      "rag.dense_recall_degraded",
      expect.objectContaining({ symbol: "AAPL", reason: "lookup_failed" })
    );
  });

  it("thrown pipeline error -> lookup_failed: a rejecting Pinecone query hits the outer catch", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.query.mockRejectedValue(new Error("simulated Pinecone outage"));
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks).toEqual([]);
    expect(status).toBe("lookup_failed");
  });

  it("missing index -> lookup_failed: indexExists() false returns [] before any query call", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "some-other-index" }] });
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks).toEqual([]);
    expect(status).toBe("lookup_failed");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("real zero-match -> no_memory: pipeline runs cleanly, Pinecone returns zero matches", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.query.mockResolvedValue({ matches: [] });
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks).toEqual([]);
    expect(status).toBe("no_memory");
  });

  it("happy path -> ok: non-empty result reports status ok and chunk selection is unaffected", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks.map((c) => c.id)).toEqual(["chunk-1"]);
    expect(status).toBe("ok");
  });

  it("degraded: R16 per-run budget trip reports status degraded on a NON-empty result", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    const { resetRunBudget, recordRagOperation } = await import("../src/lib/rag/run-budget");
    process.env.RAG_RUN_BUDGET_ENABLED = "on";
    process.env.RAG_RUN_BUDGET_CEILING = "1"; // ceiling() falls back to the 5000 default for <=0
    resetRunBudget();
    recordRagOperation(); // pre-seed one op so the ceiling is already met before this call
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks.length).toBeGreaterThan(0); // degrade skips rerank/hybrid only, never core recall
    expect(status).toBe("degraded");
  });

  it("rerank route unavailable + clean zero-match -> no_memory (not degraded)", async () => {
    // Explicit rerank provider configured without credentials, and the Voyage mock client lacks
    // rerank so mock-client admission cannot paper over the missing credential. Dense recall still
    // succeeds with zero matches — that is a real empty lookup, not a quality degrade.
    const { retrieveContextDetailed } = await freshVectorDb({ voyageClientHasRerank: false });
    process.env.VECTOR_ENABLE_RERANK = "on";
    process.env.RAG_RERANK_PROVIDER = "openrouter";
    // openrouter credential absent (resolveApiKey only returns pinecone/voyage).
    mocks.query.mockResolvedValue({ matches: [] });
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks).toEqual([]);
    expect(status).toBe("no_memory");
  });

  it("rerank route unavailable + non-empty recall -> degraded", async () => {
    const { retrieveContextDetailed } = await freshVectorDb({ voyageClientHasRerank: false });
    process.env.VECTOR_ENABLE_RERANK = "on";
    process.env.RAG_RERANK_PROVIDER = "openrouter";
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    let status: string | undefined;
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: (s) => {
        status = s;
      }
    });
    expect(chunks.map((c) => c.id)).toEqual(["chunk-1"]);
    expect(status).toBe("degraded");
  });

  it("a throwing onStatus callback never breaks retrieval (advisory receipt only)", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local", {
      onStatus: () => {
        throw new Error("boom");
      }
    });
    expect(chunks.map((c) => c.id)).toEqual(["chunk-1"]);
  });

  it("omitting onStatus is byte-identical to existing callers (no behavior change)", async () => {
    const { retrieveContextDetailed } = await freshVectorDb();
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).toEqual(["chunk-1"]);
  });

  it("retrieveContextDetailedWithStatus returns {chunks, status} matching the onStatus receipt", async () => {
    const { retrieveContextDetailedWithStatus } = await freshVectorDb();
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    const { chunks, status } = await retrieveContextDetailedWithStatus("query", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).toEqual(["chunk-1"]);
    expect(status).toBe("ok");
  });

  it("retrieveContextDetailedWithStatus surfaces lookup_failed for missing keys", async () => {
    const { retrieveContextDetailedWithStatus } = await freshVectorDb();
    mocks.resolveApiKey.mockImplementation(() => undefined);
    const { chunks, status } = await retrieveContextDetailedWithStatus("query", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
    expect(status).toBe("lookup_failed");
  });

  it("a throwing caller-supplied onStatus does not break retrieveContextDetailedWithStatus", async () => {
    const { retrieveContextDetailedWithStatus } = await freshVectorDb();
    mocks.query.mockResolvedValue({ matches: [HEALTHY_MATCH] });
    const throwingOnStatus = vi.fn(() => {
      throw new Error("boom — a broken receipt callback must never break retrieval");
    });
    const { chunks, status } = await retrieveContextDetailedWithStatus("query", "AAPL", 3, "local", {
      onStatus: throwingOnStatus
    });
    expect(chunks.map((c) => c.id)).toEqual(["chunk-1"]);
    expect(status).toBe("ok");
    expect(throwingOnStatus).toHaveBeenCalledWith("ok");
  });
});

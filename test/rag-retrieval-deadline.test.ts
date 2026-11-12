// Issue #2961: a hung strategy-run RAG retrieve must abort instead of stalling the loop.
import { pinRagQualityFlagsOff } from "./rag-test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStrategyRagRetrievalDeadline } from "../src/lib/rag-retrieval-deadline";

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
  getPolicy: () => ({ tuning: {} }),
  DAILY_RESET_TIME_ZONE: "America/New_York",
  startOfDayInTimeZone: () => new Date(0)
}));

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

function hangUntilAbort(signal: AbortSignal | undefined, label: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(signal?.reason instanceof Error ? signal.reason : new Error(label));
    if (!signal) return;
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

beforeEach(() => {
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.RAG_QUERY_EMBED_CACHE;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.query.mockResolvedValue({ matches: [] });
});

describe("strategy RAG retrieval deadline (#2961)", () => {
  it("aborts a hung query embed when the caller signal fires", async () => {
    mocks.embed.mockImplementation((_body: unknown, opts?: { abortSignal?: AbortSignal }) =>
      hangUntilAbort(opts?.abortSignal, "embed hung")
    );
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const controller = new AbortController();
    const started = Date.now();
    const pending = retrieveContextDetailed("AAPL catalysts", "AAPL", 2, "local", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("rag deadline")), 40);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toEqual([]);
    expect(mocks.embed).toHaveBeenCalled();
    const opts = mocks.embed.mock.calls[0]?.[1] as { abortSignal?: AbortSignal } | undefined;
    expect(opts?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(opts?.abortSignal?.aborted).toBe(true);
  });

  it("stops waiting on a hung Pinecone query when the caller signal fires", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    mocks.query.mockImplementation(() => hangUntilAbort(undefined, "query hung"));
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const controller = new AbortController();
    const started = Date.now();
    const pending = retrieveContextDetailed("AAPL catalysts", "AAPL", 2, "local", { signal: controller.signal });
    const settled = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    setTimeout(() => controller.abort(new Error("rag deadline")), 40);
    const outcome = await settled;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mocks.query).toHaveBeenCalled();
    if (outcome.ok) {
      expect(outcome.value).toEqual([]);
    } else {
      expect(outcome.error).toBeInstanceOf(Error);
    }
  });

  it("soft-skips a hung retrieve at the strategy deadline and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const result = await withStrategyRagRetrievalDeadline(
      (signal) => {
        seen = signal;
        return hangUntilAbort(signal, "retrieve hung");
      },
      () => "skipped",
      50
    );
    expect(result).toBe("skipped");
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

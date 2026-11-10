import { beforeEach, describe, expect, it, vi } from "vitest";

// Finding 7.1 (P1 correction, 2026-07-15): a prior fix zeroed estimatedCostUsd at the Voyage
// embed/rerank dispatch call sites (withDurableRagProviderDispatch, service "provider-dispatch")
// to stop double-counting Voyage spend once the usage-monitor receiver aggregates
// ExternalUsageEvent by provider name (ignoring `service`) — the pre-existing ledger lane
// (meterEmbed/meterRerank -> recordRagUsage, service "rag") already reports the real cost. But
// that zeroing landed on the wrong side of the boundary: `reserveProviderDispatch`'s
// `maxEstimatedCostUsdPer24h` check (the local per-credential $/day cost-cap fuse,
// PROVIDER_DISPATCH_VOYAGE_*_MAX_COST_USD_PER_DAY) sums `estimated_cost_usd` on
// `provider_dispatch_attempts` — with every reservation at 0 that fuse could never trip.
//
// The correct split, verified by the two describe blocks below:
//   1. The LOCAL reservation (reserveProviderDispatch, in vector-db.ts) must carry the REAL
//      Voyage cost estimate again, so the local daily cost-cap fuse still works.
//   2. The event actually PUSHED to the usage monitor for service "provider-dispatch"
//      (createProviderDispatchUsageMonitorEvent in usage-monitor-push.ts — the single choke point
//      for every provider-dispatch delivery, live and crash-replay alike) must always carry no
//      cost, for every provider, regardless of what the local reservation estimated.
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
    reserveProviderDispatch: vi.fn((_input: any) => ({
      admitted: true as const,
      attemptId: "voyage-attempt",
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
  filterNewDocumentChunks: vi.fn((chunks) => chunks),
  insertDocumentChunks: vi.fn(),
  getDb: mocks.getDb,
  reserveProviderDispatch: mocks.reserveProviderDispatch,
  markProviderDispatchStarted: mocks.markProviderDispatchStarted,
  settleProviderDispatch: mocks.settleProviderDispatch
}));

vi.mock("../src/lib/user-write-fence", () => ({
  assertUserOperationClaim: vi.fn(),
  withUserWriteOperation: vi.fn(async (
    userId: string,
    kind: string,
    work: (claim: { userId: string; key: string; claimId: string; kind: string; epoch: { generation: string; status: "none" } }) => Promise<unknown>
  ) => work({ userId, key: `claim:${userId}`, claimId: "test-claim", kind, epoch: { generation: "none", status: "none" } }))
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.OPENROUTER_API_KEY = "openrouter-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "openrouter") return process.env.OPENROUTER_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.reserveProviderDispatch.mockReturnValue({
    admitted: true as const,
    attemptId: "openrouter-attempt",
    authorityId: "local"
  });
});

describe("OpenRouter LOCAL dispatch reservation keeps a real cost estimate (daily cost-cap fuse)", () => {
  it("reserves the embed dispatch with a real, non-zero OpenRouter cost estimate", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 8-K Item 2.02 details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } }
    ]);

    expect(mocks.reserveProviderDispatch).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter"
    }));
    const call = mocks.reserveProviderDispatch.mock.calls.find(
      ([input]) => input.provider === "openrouter"
    );
    expect(call).toBeDefined();
    const [input] = call!;
    // Must be a real cost estimate (matching estimateRagDispatchCost/estimateRagCost's pricing
    // table), not the flat 0 that would silently disable reserveProviderDispatch's
    // maxEstimatedCostUsdPer24h fuse.
    expect(typeof input.estimatedCostUsd).toBe("number");
    expect(input.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("reserves the rerank dispatch with a real, non-zero OpenRouter cost estimate", async () => {
    mocks.rerank.mockResolvedValue({ data: [{ index: 0, relevanceScore: 0.9 }] });
    const { rerankMatches } = await import("../src/lib/vector-db");
    const voyage = { rerank: mocks.rerank } as any;

    // rerankMatches short-circuits (no dispatch) for a single match — needs ≥2 to reach OpenRouter.
    await rerankMatches(
      voyage,
      "AAPL guidance",
      [
        { id: "m1", score: 0.5, metadata: { text: "AAPL raised full-year guidance." } },
        { id: "m2", score: 0.4, metadata: { text: "AAPL announced a buyback." } }
      ],
      1
    );

    expect(mocks.reserveProviderDispatch).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter"
    }));
    const call = mocks.reserveProviderDispatch.mock.calls.find(
      ([input]) => input.provider === "openrouter"
    );
    expect(call).toBeDefined();
    const [input] = call!;
    expect(typeof input.estimatedCostUsd).toBe("number");
    expect(input.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe("Provider-dispatch PUSH boundary is always cost-free externally", () => {
  it("never includes costUsd in the pushed provider-dispatch event, even given a real local Voyage estimate", async () => {
    const { createProviderDispatchUsageMonitorEvent } = await import("../src/lib/usage-monitor-push");

    const event = await createProviderDispatchUsageMonitorEvent({
      sourceEventId: "voyage-attempt-1",
      occurredAt: "2026-07-15T00:00:00.000Z",
      provider: "voyage",
      operation: "embed document",
      credentialRef: "voyage-cred-fingerprint",
      userId: "local",
      outcome: "succeeded",
      requests: 1,
      // The exact kind of real, non-zero local estimate the fix above now produces — must not
      // leak into the pushed event (that's the RAG ledger lane's job, service "rag").
      estimatedCostUsd: 0.0042
    });

    expect(event).not.toBeNull();
    expect(event!.service).toBe("provider-dispatch");
    expect(event!.provider).toBe("voyage");
    expect(event!.costUsd).toBeUndefined();
    expect(event!.metricType).toBe("usage");
    expect(event!.billingMode).toBe("estimated");
  });

  it("stays cost-free even if a real actualCostUsd is ever supplied (defense against re-plumbing cost through this boundary)", async () => {
    const { createProviderDispatchUsageMonitorEvent } = await import("../src/lib/usage-monitor-push");

    const event = await createProviderDispatchUsageMonitorEvent({
      sourceEventId: "voyage-attempt-2",
      occurredAt: "2026-07-15T00:00:01.000Z",
      provider: "voyage",
      operation: "rerank",
      credentialRef: "voyage-cred-fingerprint",
      userId: "local",
      outcome: "succeeded",
      requests: 1,
      estimatedCostUsd: 0.0042,
      actualCostUsd: 0.0039
    });

    expect(event).not.toBeNull();
    expect(event!.costUsd).toBeUndefined();
    expect(event!.metricType).toBe("usage");
  });

  it("stays cost-free for a zero-cost provider too (FMP convention unaffected)", async () => {
    const { createProviderDispatchUsageMonitorEvent } = await import("../src/lib/usage-monitor-push");

    const event = await createProviderDispatchUsageMonitorEvent({
      sourceEventId: "fmp-attempt-1",
      occurredAt: "2026-07-15T00:00:02.000Z",
      provider: "fmp",
      operation: "capability-quote",
      credentialRef: "fmp-cred-fingerprint",
      userId: "local",
      outcome: "succeeded",
      requests: 1,
      estimatedCostUsd: 0
    });

    expect(event).not.toBeNull();
    expect(event!.costUsd).toBeUndefined();
    expect(event!.metricType).toBe("usage");
  });
});

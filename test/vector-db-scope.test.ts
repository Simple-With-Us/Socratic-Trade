import { pinRagQualityFlagsOff } from "./rag-test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the scope:'shared'|'private' metadata field added to the RAG layer.
 *
 * The key correctness properties checked here:
 *  1. Shared-tier writes carry scope:'shared'.
 *  2. Private-tier writes carry scope:'private'.
 *  3. The shared-tier query filter uses a Pinecone $or that matches BOTH
 *     scope:'shared' (new vectors) AND userId:'local' (legacy pre-scope vectors).
 *  4. The private-tier query filter still matches by the user's own userId.
 */

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const listPaginated = vi.fn();
  const fetchRecords = vi.fn();
  const deleteMany = vi.fn();
  const deleteAll = vi.fn();
  const rerank = vi.fn();
  const namespacedIndex = { upsert, query, listPaginated, fetch: fetchRecords, deleteMany, deleteAll };
  const namespace = vi.fn(() => namespacedIndex);
  const index = vi.fn(() => ({ ...namespacedIndex, namespace }));
  const settings = new Map<string, string>();
  const manifests = new Map<string, { ledger_authority: string; provider_authority: string }>();
  const prepare = vi.fn((sql: string) => {
    if (sql.includes("INSERT OR IGNORE INTO settings")) return {
      run: vi.fn((key: string, value: string) => {
        if (!settings.has(key)) settings.set(key, value);
      })
    };
    if (sql.includes("SELECT value FROM settings WHERE key")) return {
      get: vi.fn((key: string) => settings.has(key) ? { value: settings.get(key) } : undefined)
    };
    if (sql.includes("INSERT OR IGNORE INTO vector_private_namespace_manifests")) return {
      run: vi.fn((tenantScope: string, ledgerAuthority: string, providerAuthority: string) => {
        if (!manifests.has(tenantScope)) {
          manifests.set(tenantScope, {
            ledger_authority: ledgerAuthority,
            provider_authority: providerAuthority
          });
        }
      })
    };
    if (sql.includes("SELECT 1 AS ok") && sql.includes("FROM vector_private_namespace_manifests WHERE tenant_scope")) return {
      get: vi.fn((tenantScope: string, ledgerAuthority: string, providerAuthority: string) => {
        const manifest = manifests.get(tenantScope);
        return manifest?.ledger_authority === ledgerAuthority && manifest.provider_authority === providerAuthority
          ? { ok: 1 }
          : undefined;
      })
    };
    if (sql.includes("FROM vector_private_namespace_manifests WHERE tenant_scope")) return {
      get: vi.fn((tenantScope: string) => manifests.get(tenantScope))
    };
    if (sql.includes("SELECT DISTINCT ledger_authority FROM vector_private_namespace_manifests")) return {
      all: vi.fn(() => [...manifests.values()].map(({ ledger_authority }) => ({ ledger_authority })))
    };
    if (sql.includes("SELECT DISTINCT ledger_authority") || sql.includes("SELECT COUNT(*) FROM vector_ingest_commits")) {
      return { all: vi.fn(() => []), get: vi.fn(() => ({ count: 0 })) };
    }
    return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
  });
  const database = {
    transaction: vi.fn((work: () => unknown) => ({ immediate: () => work() })),
    prepare
  };
  const getDb = vi.fn<() => any>(() => database);
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    describeIndex: vi.fn(),
    createIndex: vi.fn(),
    embed: vi.fn(),
    rerank,
    resolveApiKey: vi.fn(),
    getDb,
    audit: vi.fn(),
    listPaginated,
    fetchRecords,
    deleteMany,
    deleteAll,
    namespace,
    settings,
    manifests,
    database
  };
});

const fenceMocks = vi.hoisted(() => ({
  assertUserOperationClaim: vi.fn(),
  withUserWriteOperation: vi.fn(async (
    userId: string,
    kind: string,
    work: (claim: { userId: string; key: string; claimId: string; kind: string; epoch: { generation: string; status: "none" } }) => Promise<unknown>
  ) => work({
    userId,
    key: `claim:${userId}`,
    claimId: "test-claim",
    kind,
    epoch: { generation: "none", status: "none" }
  }))
}));

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      describeIndex: mocks.describeIndex,
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
  audit: mocks.audit,
  getDb: mocks.getDb,
  setInternalSetting: vi.fn()
}));

vi.mock("../src/lib/user-write-fence", () => ({
  assertUserOperationClaim: fenceMocks.assertUserOperationClaim,
  withUserWriteOperation: fenceMocks.withUserWriteOperation
}));

beforeEach(() => {
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.RAG_VECTOR_WRITE_QDRANT = "0";
  delete process.env.QDRANT_URL;
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.VECTOR_EMBED_BATCH_SIZE;
  delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
  delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;
  delete process.env.RAG_MANAGED_VERSION_TOP_K_CAP;
  delete process.env.VECTOR_RERANK_OVERFETCH_K;
  delete process.env.VECTOR_ENABLE_RERANK;
  process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS = "1";
  process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN = "1";
  process.env.VECTOR_ERASURE_VERIFY_DELAY_MS = "0";
  mocks.settings.clear();
  mocks.manifests.clear();
  mocks.getDb.mockReturnValue(mocks.database);
  mocks.describeIndex.mockResolvedValue({
    host: "socratic-trade-test.svc.test.pinecone.io",
    metric: "cosine"
  });
  mocks.deleteAll.mockResolvedValue(undefined);
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
});

const COMMITTED_RECEIPT_CLAUSE = {
  $or: [
    { receipt_required: { $exists: false } },
    { receipt_required: { $eq: false } },
    { ingest_state: { $eq: "committed" } }
  ]
};

function unwrapCommittedFilter(filter: Record<string, unknown>): Record<string, unknown> {
  expect(Array.isArray(filter.$and)).toBe(true);
  const clauses = filter.$and as Record<string, unknown>[];
  expect(clauses).toHaveLength(2);
  expect(clauses[1]).toEqual(COMMITTED_RECEIPT_CLAUSE);
  return clauses[0]!;
}

describe("vector-db scope metadata", () => {
  describe("write path — cleanMetadata", () => {
    it("sets scope:'shared' on shared-tier (userId=local) writes", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts } = await import("../src/lib/vector-db");

      await storeContexts([
        {
          text: "AAPL shared context",
          metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" }
        }
      ]); // default userId = "local" → shared tier

      const records = mocks.upsert.mock.calls[0][0].records;
      expect(records).toHaveLength(1);
      expect(records[0].metadata).toMatchObject({
        userId: "local",
        scope: "shared",
        provider_authority: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    });

    it("sets scope:'private' on user-private writes", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts } = await import("../src/lib/vector-db");

      await storeContexts(
        [
          {
            text: "Private AAPL context",
            metadata: { symbol: "AAPL", source: "notes", timestamp: "2026-06-18", accession: "p1" }
          }
        ],
        "user-42"
      );

      const records = mocks.upsert.mock.calls[0][0].records;
      expect(records).toHaveLength(1);
      expect(records[0].metadata).toMatchObject({
        userId: "user-42",
        scope: "private"
      });
    });

    it("does not allow caller metadata to spoof the scope field", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts } = await import("../src/lib/vector-db");

      await storeContexts(
        [
          {
            text: "Private context with spoofed scope",
            metadata: {
              symbol: "AAPL",
              source: "notes",
              timestamp: "2026-06-18",
              scope: "shared", // attacker tries to promote to shared tier
              tenant_scope: "shared:operator",
              provider_authority: "spoofed-provider"
            }
          }
        ],
        "user-42"
      );

      const records = mocks.upsert.mock.calls[0][0].records;
      expect(records[0].metadata.scope).toBe("private");
      expect(records[0].metadata.userId).toBe("user-42");
      expect(records[0].metadata.tenant_scope).toMatch(/^private:[a-f0-9]{64}$/);
      expect(records[0].metadata.provider_authority).toMatch(/^[a-f0-9]{64}$/);
      expect(records[0].metadata.provider_authority).not.toBe("spoofed-provider");
    });

    it("forces a non-local caller requesting shared scope into its private namespace", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts, vectorTenantScope } = await import("../src/lib/vector-db");

      await storeContexts(
        [{
          text: "Tenant-controlled context",
          metadata: { symbol: "AAPL", source: "notes", timestamp: "2026-07-14" }
        }],
        "user-42",
        { scope: "shared" }
      );

      const metadata = mocks.upsert.mock.calls[0][0].records[0].metadata;
      expect(metadata).toMatchObject({
        userId: "user-42",
        scope: "private",
        tenant_scope: vectorTenantScope("user-42", "private")
      });
      expect(fenceMocks.withUserWriteOperation).toHaveBeenCalledWith(
        "user-42",
        "vector-store-contexts",
        expect.any(Function)
      );
    });

    it("keeps local operator memory private when the corpus explicitly requests it", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts, vectorTenantScope } = await import("../src/lib/vector-db");

      await storeContexts(
        [{
          text: "Private operator decision",
          metadata: {
            symbol: "AAPL",
            source: "experience-memory",
            timestamp: "2026-07-14",
            scope: "shared",
            tenant_scope: "shared:operator"
          }
        }],
        "local",
        { scope: "private" }
      );

      const metadata = mocks.upsert.mock.calls[0][0].records[0].metadata;
      expect(metadata).toMatchObject({
        userId: "local",
        scope: "private",
        tenant_scope: vectorTenantScope("local", "private")
      });
    });

    it("refuses exact private-vector verification under a different provider or manifest authority", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.upsert.mockResolvedValue(undefined);
      const {
        fetchExistingVectorRecordIds,
        getCurrentVectorProviderAuthority,
        managedVectorLedgerAuthority,
        storeContexts
      } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private authority-bound context",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "user-42", { scope: "private" });
      const providerAuthority = await getCurrentVectorProviderAuthority({ userId: "user-42" });
      const ledgerAuthority = managedVectorLedgerAuthority();

      await expect(fetchExistingVectorRecordIds({
        userId: "user-42",
        namespace: "private",
        ids: ["authority-bound-id"],
        expectedProviderAuthority: "provider:rotated",
        ledgerAuthority
      })).rejects.toThrow("provider authority mismatch");
      await expect(fetchExistingVectorRecordIds({
        userId: "user-42",
        namespace: "private",
        ids: ["authority-bound-id"],
        expectedProviderAuthority: providerAuthority,
        ledgerAuthority: "ledger:v1:historical"
      })).rejects.toThrow("manifest authority mismatch");
      expect(mocks.fetchRecords).not.toHaveBeenCalled();
    });
  });

  describe("read path — shared-tier query filter (backward-compat $or)", () => {
    it("local retrieval queries private and shared tiers without treating scoped local memory as public", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.query.mockResolvedValue({ matches: [] });
      mocks.upsert.mockResolvedValue(undefined);
      const { retrieveContext, storeContexts } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private operator decision",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "local", { scope: "private" });
      mocks.query.mockClear();

      await retrieveContext("AAPL catalysts", "AAPL", 3);

      // Each tier gets its own topK pool so a saturated private tier cannot starve shared evidence
      // (or vice versa) before reranking.
      expect(mocks.query).toHaveBeenCalledTimes(3);
      const privateFilter = unwrapCommittedFilter(mocks.query.mock.calls[0][0].filter);
      expect(privateFilter).toMatchObject({
        symbol: { $eq: "AAPL" },
        userId: { $eq: "local" }
      });
      expect(privateFilter.$or).toEqual(expect.arrayContaining([
        expect.objectContaining({ tenant_scope: expect.any(Object) }),
        { $and: [{ tenant_scope: { $exists: false } }, { scope: { $eq: "private" } }] },
        { $and: [{ tenant_scope: { $exists: false } }, { scope: { $exists: false } }] }
      ]));

      const privateNamespaceFilter = unwrapCommittedFilter(mocks.query.mock.calls[1][0].filter);
      expect(privateNamespaceFilter).toEqual(privateFilter);

      const sharedFilter = unwrapCommittedFilter(mocks.query.mock.calls[2][0].filter);
      expect(sharedFilter.symbol).toEqual({ $eq: "AAPL" });
      expect(sharedFilter.$or).toEqual(
        expect.arrayContaining([
          { scope: { $eq: "shared" } },
          {
            $and: [
              { userId: { $eq: "local" } },
              { scope: { $exists: false } }
            ]
          }
        ])
      );
    });

    it("preserves shared recall when the local private tier saturates its candidate quota", async () => {
      process.env.VECTOR_ENABLE_RERANK = "on";
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.upsert.mockResolvedValue(undefined);
      const { retrieveContext, storeContexts, vectorTenantScope } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private operator decision",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "local", { scope: "private" });
      mocks.query.mockReset();
      mocks.query
        .mockResolvedValueOnce({
          matches: Array.from({ length: 3 }, (_, index) => ({
            id: `private-${index}`,
            score: 0.9 - index / 100,
            metadata: {
              text: `private-${index}`,
              userId: "local",
              scope: "private",
              tenant_scope: vectorTenantScope("local", "private")
            }
          }))
        })
        .mockResolvedValueOnce({ matches: [] })
        .mockResolvedValueOnce({
          matches: [{
            id: "shared-catalyst",
            score: 0.1,
            metadata: {
              text: "shared-catalyst",
              userId: "local",
              scope: "shared",
              tenant_scope: "shared:operator"
            }
          }]
        });
      mocks.rerank.mockImplementation(async ({ documents }: { documents: string[] }) => {
        const sharedIndex = documents.findIndex((document) => document.includes("shared-catalyst"));
        const remaining = documents
          .map((_document, index) => index)
          .filter((index) => index !== sharedIndex);
        return {
          data: [
            { index: sharedIndex, relevanceScore: 0.99 },
            ...remaining.map((index, rank) => ({ index, relevanceScore: 0.8 - rank / 10 }))
          ]
        };
      });

      const results = await retrieveContext("AAPL catalysts", "AAPL", 3);

      expect(mocks.query).toHaveBeenCalledTimes(3);
      expect(mocks.query.mock.calls.map(([request]) => request.topK)).toEqual([150, 150, 150]);
      expect(mocks.rerank).toHaveBeenCalledWith(expect.objectContaining({
        documents: expect.arrayContaining([
          expect.stringContaining("shared-catalyst"),
          expect.stringContaining("private-0")
        ])
      }));
      expect(results).toContain("shared-catalyst");
      expect(results.indexOf("shared-catalyst")).toBeLessThan(results.indexOf("private-0"));
    });

    it("fairly caps a saturated multi-tier union at Voyage's 1,000-document rerank limit", async () => {
      process.env.VECTOR_ENABLE_RERANK = "on";
      process.env.VECTOR_RERANK_OVERFETCH_K = "1000";
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.upsert.mockResolvedValue(undefined);
      const { retrieveContext, storeContexts, vectorTenantScope } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private operator decision",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "local", { scope: "private" });
      mocks.query.mockReset();
      const privateMatches = Array.from({ length: 1_000 }, (_, index) => ({
        id: `private-saturated-${index}`,
        score: 0.99 - index / 100_000,
        metadata: {
          text: `private-saturated-${index}`,
          userId: "local",
          scope: "private",
          tenant_scope: vectorTenantScope("local", "private")
        }
      }));
      const sharedMatches = Array.from({ length: 1_000 }, (_, index) => ({
        id: `shared-saturated-${index}`,
        score: 0.1 - index / 100_000,
        metadata: {
          text: `shared-saturated-${index}`,
          userId: "local",
          scope: "shared",
          tenant_scope: "shared:operator"
        }
      }));
      mocks.query
        .mockResolvedValueOnce({ matches: privateMatches })
        .mockResolvedValueOnce({ matches: [] })
        .mockResolvedValueOnce({ matches: sharedMatches });
      mocks.rerank.mockImplementation(async ({ documents }: { documents: string[] }) => {
        const sharedIndex = documents.findIndex((document) => document === "shared-saturated-0");
        return {
          data: [
            { index: sharedIndex, relevanceScore: 0.99 },
            { index: 0, relevanceScore: 0.8 },
            { index: 1, relevanceScore: 0.7 }
          ]
        };
      });

      const results = await retrieveContext("AAPL catalysts", "AAPL", 3);

      expect(mocks.query.mock.calls.map(([request]) => request.topK)).toEqual([1000, 1000, 1000]);
      const documents = mocks.rerank.mock.calls[0][0].documents as string[];
      expect(documents).toHaveLength(1_000);
      expect(documents.filter((document) => document.startsWith("private-saturated-"))).toHaveLength(500);
      expect(documents.filter((document) => document.startsWith("shared-saturated-"))).toHaveLength(500);
      expect(results).toContain("shared-saturated-0");
    });

    it("removes stale managed generations before they consume a tier's rerank quota", async () => {
      process.env.VECTOR_ENABLE_RERANK = "on";
      process.env.VECTOR_RERANK_OVERFETCH_K = "1000";
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.upsert.mockResolvedValue(undefined);
      const { retrieveContext, storeContexts, vectorTenantScope } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private operator decision",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "local", { scope: "private" });
      mocks.query.mockReset();
      const staleManagedMatches = Array.from({ length: 900 }, (_, index) => ({
        id: `occ:v3:stale-managed-${index}`,
        score: 0.99 - index / 100_000,
        metadata: {
          text: `stale-managed-${index}`,
          userId: "local",
          scope: "private",
          tenant_scope: vectorTenantScope("local", "private"),
          receipt_required: true,
          ingest_state: "committed",
          provider_authority: "provider:stale",
          ledger_authority: "ledger:stale"
        }
      }));
      const validPrivateMatches = Array.from({ length: 100 }, (_, index) => ({
        id: `private-current-${index}`,
        score: 0.08 - index / 100_000,
        metadata: {
          text: `private-current-${index}`,
          userId: "local",
          scope: "private",
          tenant_scope: vectorTenantScope("local", "private")
        }
      }));
      const sharedMatches = Array.from({ length: 1_000 }, (_, index) => ({
        id: `shared-current-${index}`,
        score: 0.1 - index / 100_000,
        metadata: {
          text: `shared-current-${index}`,
          userId: "local",
          scope: "shared",
          tenant_scope: "shared:operator"
        }
      }));
      mocks.query
        .mockResolvedValueOnce({ matches: [...staleManagedMatches, ...validPrivateMatches] })
        .mockResolvedValueOnce({ matches: [] })
        .mockResolvedValueOnce({ matches: sharedMatches });
      mocks.rerank.mockImplementation(async ({ documents }: { documents: string[] }) => ({
        data: documents.slice(0, 3).map((_document, index) => ({
          index,
          relevanceScore: 1 - index / 10
        }))
      }));

      await retrieveContext("AAPL catalysts", "AAPL", 3);

      const documents = mocks.rerank.mock.calls[0][0].documents as string[];
      expect(documents).toHaveLength(1_000);
      expect(documents.some((document) => document.startsWith("stale-managed-"))).toBe(false);
      expect(documents.filter((document) => document.startsWith("private-current-"))).toHaveLength(100);
      expect(documents.filter((document) => document.startsWith("shared-current-"))).toHaveLength(900);
    });

    it("preserves tier breadth through multi-query fusion before reranking", async () => {
      process.env.VECTOR_ENABLE_RERANK = "on";
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.upsert.mockResolvedValue(undefined);
      const { retrieveContextDetailed, storeContexts, vectorTenantScope } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private operator decision",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "local", { scope: "private" });
      mocks.query.mockReset();
      const privateMatches = Array.from({ length: 150 }, (_, index) => ({
        id: `multi-private-${index}`,
        score: 0.99 - index / 100_000,
        metadata: {
          text: `multi-private-${index}`,
          userId: "local",
          scope: "private",
          tenant_scope: vectorTenantScope("local", "private")
        }
      }));
      const sharedMatches = Array.from({ length: 150 }, (_, index) => ({
        id: `multi-shared-${index}`,
        score: 0.1 - index / 100_000,
        metadata: {
          text: `multi-shared-${index}`,
          userId: "local",
          scope: "shared",
          tenant_scope: "shared:operator"
        }
      }));
      mocks.query.mockImplementation(async () => {
        const queryIndex = mocks.query.mock.calls.length - 1;
        if (queryIndex % 3 === 0) return { matches: privateMatches };
        if (queryIndex % 3 === 1) return { matches: [] };
        return { matches: sharedMatches };
      });
      mocks.rerank.mockImplementation(async ({ documents }: { documents: string[] }) => ({
        data: documents.slice(0, 3).map((_document, index) => ({
          index,
          relevanceScore: 1 - index / 10
        }))
      }));

      await retrieveContextDetailed("AAPL catalysts", "AAPL", 3, "local", {
        queries: ["AAPL risks"]
      });

      expect(mocks.query).toHaveBeenCalledTimes(6);
      expect(mocks.query.mock.calls.map(([request]) => request.topK)).toEqual(Array(6).fill(150));
      const documents = mocks.rerank.mock.calls[0][0].documents as string[];
      expect(documents).toHaveLength(300);
      expect(documents.filter((document) => document.startsWith("multi-private-"))).toHaveLength(150);
      expect(documents.filter((document) => document.startsWith("multi-shared-"))).toHaveLength(150);
    });

    it("private-tier query includes the user's own userId filter (not $or)", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.query.mockResolvedValue({ matches: [] });
      mocks.upsert.mockResolvedValue(undefined);
      const { retrieveContext, storeContexts } = await import("../src/lib/vector-db");

      await storeContexts([{
        text: "Private user decision",
        metadata: { symbol: "AAPL", source: "socratic-memory", timestamp: "2026-07-14" }
      }], "user-42", { scope: "private" });
      mocks.query.mockClear();

      await retrieveContext("AAPL catalysts", "AAPL", 3, "user-42");

      // Legacy default-private, isolated private namespace, then shared default tier.
      expect(mocks.query).toHaveBeenCalledTimes(3);

      // First query = user's private docs
      const privateFilter = unwrapCommittedFilter(mocks.query.mock.calls[0][0].filter);
      expect(privateFilter).toMatchObject({
        symbol: { $eq: "AAPL" },
        userId: { $eq: "user-42" }
      });
      expect(privateFilter.$or).toEqual(expect.arrayContaining([
        expect.objectContaining({ tenant_scope: expect.any(Object) }),
        { $and: [{ tenant_scope: { $exists: false } }, { scope: { $eq: "private" } }] },
        { $and: [{ tenant_scope: { $exists: false } }, { scope: { $exists: false } }] }
      ]));

      const privateNamespaceFilter = unwrapCommittedFilter(mocks.query.mock.calls[1][0].filter);
      expect(privateNamespaceFilter).toEqual(privateFilter);

      // Third query = shared tier (backward-compat $or)
      const sharedFilter = unwrapCommittedFilter(mocks.query.mock.calls[2][0].filter);
      expect(sharedFilter.symbol).toEqual({ $eq: "AAPL" });
      expect(sharedFilter.$or).toEqual(
        expect.arrayContaining([
          { scope: { $eq: "shared" } },
          {
            $and: [
              { userId: { $eq: "local" } },
              { scope: { $exists: false } }
            ]
          }
        ])
      );
    });
  });

  describe("post-fetch tenant visibility", () => {
    it("drops legacy local account memory for another user while retaining public legacy corpus", async () => {
      const { filterMatchesForTenantVisibility } = await import("../src/lib/vector-db");
      const matches = [
        { id: "personal", metadata: { userId: "local", memory_scope: "account", text: "decision" } },
        { id: "personal-shared", metadata: { userId: "local", scope: "shared", memory_scope: "account", text: "old decision" } },
        { id: "public", metadata: { userId: "local", source: "sec-8k", text: "filing" } },
        { id: "own", metadata: { userId: "user-42", memory_scope: "account", text: "own decision" } },
        { id: "other-scope-only", metadata: { userId: "user-99", scope: "shared", text: "account-linked" } }
      ];

      expect(filterMatchesForTenantVisibility(matches, "user-42").map((match) => match.id)).toEqual([
        "public",
        "own"
      ]);
      expect(filterMatchesForTenantVisibility(matches, "local").map((match) => match.id)).toEqual([
        "personal",
        "personal-shared",
        "public"
      ]);
    });

    it("fails closed when two raw users collapse onto one legacy sanitized id", async () => {
      const {
        filterMatchesForTenantVisibility,
        vectorMetadataBelongsToPrivateUser,
        vectorTenantScope
      } = await import("../src/lib/vector-db");
      const ambiguousUser = "a?b";
      const matches = [
        { id: "legacy-collision", metadata: { userId: "ab", scope: "private" } },
        {
          id: "current-exact-tenant",
          metadata: {
            userId: "ab",
            scope: "private",
            tenant_scope: vectorTenantScope(ambiguousUser, "private")
          }
        }
      ];

      expect(filterMatchesForTenantVisibility(matches, ambiguousUser).map((match) => match.id)).toEqual([
        "current-exact-tenant"
      ]);
      expect(vectorMetadataBelongsToPrivateUser(matches[0]!.metadata, ambiguousUser)).toBe(false);
      expect(vectorMetadataBelongsToPrivateUser(matches[1]!.metadata, ambiguousUser)).toBe(true);
    });
  });

  describe("private account vector purge", () => {
    beforeEach(() => {
      mocks.getDb.mockReturnValue({
        prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) }))
      });
    });

    it("deletes exact private and legacy account memory while preserving local public corpus", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      const legacyVectors = {
        vectors: [{ id: "public" }, { id: "private" }, { id: "legacy-personal" }, { id: "other" }]
      };
      mocks.listPaginated
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce(legacyVectors)
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce(legacyVectors)
        .mockResolvedValueOnce({ vectors: [] });
      const { purgePrivateVectorRecordsForUser, vectorTenantScope } = await import("../src/lib/vector-db");
      mocks.fetchRecords
        .mockResolvedValueOnce({
          records: {
            public: { metadata: { text: "SEC filing", userId: "local", scope: "shared", tenant_scope: "shared:operator" } },
            private: { metadata: { text: "My decision", userId: "local", scope: "private", tenant_scope: vectorTenantScope("local", "private") } },
            "legacy-personal": { metadata: { text: "Old decision", userId: "local", scope: "shared", memory_scope: "account" } },
            other: { metadata: { text: "Other user", userId: "user-2", scope: "private", tenant_scope: vectorTenantScope("user-2", "private") } }
          }
        })
        .mockResolvedValueOnce({ records: {} })
        .mockResolvedValueOnce({ records: {} });
      mocks.deleteMany.mockResolvedValue(undefined);

      const result = await purgePrivateVectorRecordsForUser({
        userId: "local",
        accountDeletionRequestId: "prepared-request",
        leaseGuard: { assertOwnership: vi.fn() }
      });

      expect(result.ids).toEqual(["legacy-personal", "private"]);
      expect(result.contentHashes).toHaveLength(2);
      expect(mocks.deleteMany).toHaveBeenCalledWith({ ids: ["legacy-personal", "private"] });
      expect(mocks.deleteAll).toHaveBeenCalledTimes(1);
    });

    it("requires only Pinecone, not an unrelated Voyage credential", async () => {
      delete process.env.VOYAGE_API_KEY;
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.listPaginated.mockResolvedValue({ vectors: [] });
      const { purgePrivateVectorRecordsForUser } = await import("../src/lib/vector-db");

      await expect(purgePrivateVectorRecordsForUser({
        userId: "local",
        accountDeletionRequestId: "prepared-request",
        leaseGuard: { assertOwnership: vi.fn() }
      })).resolves.toEqual({ ids: [], contentHashes: [], deleted: 0 });
    });

    it("fails closed when current provider identity is unavailable", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.describeIndex.mockRejectedValue(new Error("provider identity unavailable"));
      const { purgePrivateVectorRecordsForUser } = await import("../src/lib/vector-db");

      await expect(purgePrivateVectorRecordsForUser({
        userId: "user-42",
        accountDeletionRequestId: "prepared-request",
        leaseGuard: { assertOwnership: vi.fn() }
      })).rejects.toThrow("Current Pinecone authority is unavailable");
      expect(mocks.deleteAll).not.toHaveBeenCalled();
    });

    it("purges a v3 tenant id even when mutable ownership metadata is corrupted", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      const {
        buildOccurrenceVectorId,
        getCurrentVectorProviderAuthority,
        purgePrivateVectorRecordsForUser,
        vectorTenantScope
      } = await import("../src/lib/vector-db");
      const userId = "a?b";
      const providerAuthority = await getCurrentVectorProviderAuthority({ userId });
      expect(providerAuthority).toMatch(/^[a-f0-9]{64}$/);
      const id = buildOccurrenceVectorId({
        providerAuthority: providerAuthority!,
        tenantScope: vectorTenantScope(userId, "private"),
        source: "experience-memory",
        accession: "decision-1",
        contentVersion: "v1",
        section: "body",
        ordinal: 1,
        parserRevision: "v1",
        embedRevision: "v1"
      });
      mocks.listPaginated
        .mockResolvedValueOnce({ vectors: [{ id }] })
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce({ vectors: [{ id }] })
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce({ vectors: [] });
      mocks.fetchRecords
        .mockResolvedValueOnce({
          records: {
            [id]: { metadata: { userId: "someone-else", scope: "shared", tenant_scope: "shared:operator" } }
          }
        })
        .mockResolvedValueOnce({ records: {} })
        .mockResolvedValueOnce({ records: {} });
      mocks.deleteMany.mockResolvedValue(undefined);

      await expect(purgePrivateVectorRecordsForUser({
        userId,
        accountDeletionRequestId: "prepared-request",
        leaseGuard: { assertOwnership: vi.fn() }
      })).resolves.toMatchObject({ ids: [id], deleted: 1 });
    });

    it("rejects a briefly absent private vector that reappears during the stability window", async () => {
      process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS = "3";
      process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN = "2";
      const privateId = "private-reappearing";
      let listCall = 0;
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.listPaginated.mockImplementation(async () => {
        listCall += 1;
        return listCall === 3 ? { vectors: [{ id: privateId }] } : { vectors: [] };
      });
      mocks.fetchRecords
        .mockResolvedValueOnce({ records: {
          [privateId]: { metadata: { userId: "user-42", scope: "private" } }
        } })
        .mockResolvedValueOnce({ records: {} })
        .mockResolvedValueOnce({ records: {
          [privateId]: { metadata: { userId: "user-42", scope: "private" } }
        } })
        .mockResolvedValueOnce({ records: {} });
      const { purgePrivateVectorRecordsForUser } = await import("../src/lib/vector-db");

      await expect(purgePrivateVectorRecordsForUser({
        userId: "user-42",
        accountDeletionRequestId: "prepared-request",
        leaseGuard: { assertOwnership: vi.fn() }
      })).rejects.toThrow("stability verification failed");
      expect(mocks.deleteAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("managed-version topK compensation", () => {
    it("adds the local rejected-generation upper bound before provider queries", async () => {
      process.env.VECTOR_ENABLE_RERANK = "off";
      mocks.getDb.mockReturnValue({
        prepare: vi.fn((sql: string) => ({
          get: vi.fn(() => sql.includes("COUNT(*) AS rejected") ? { rejected: 7 } : undefined)
        }))
      });
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.query.mockResolvedValue({ matches: [] });
      const { retrieveContext } = await import("../src/lib/vector-db");

      await retrieveContext("AAPL catalysts", "AAPL", 3, "user-42");

      expect(mocks.query).toHaveBeenCalledTimes(2);
      for (const [request] of mocks.query.mock.calls) expect(request.topK).toBe(10);
    });

    it("reports degraded when stale generations exhaust the configured compensation cap", async () => {
      process.env.VECTOR_ENABLE_RERANK = "off";
      process.env.RAG_MANAGED_VERSION_TOP_K_CAP = "5";
      mocks.getDb.mockReturnValue({
        prepare: vi.fn((sql: string) => ({
          get: vi.fn(() => sql.includes("COUNT(*) AS rejected") ? { rejected: 100 } : undefined)
        }))
      });
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.query
        .mockResolvedValueOnce({
          matches: Array.from({ length: 5 }, (_, index) => ({
            id: `private-${index}`,
            score: 1 - index / 10,
            metadata: { text: `private ${index}`, userId: "user-42", scope: "private" }
          }))
        })
        .mockResolvedValueOnce({ matches: [] })
        .mockResolvedValueOnce({ matches: [] });
      const onStatus = vi.fn();
      const { retrieveContextDetailed } = await import("../src/lib/vector-db");

      await retrieveContextDetailed("AAPL catalysts", "AAPL", 3, "user-42", { onStatus });

      expect(mocks.query.mock.calls[0][0].topK).toBe(5);
      expect(onStatus).toHaveBeenCalledWith("degraded");
      expect(mocks.audit).toHaveBeenCalledWith(
        "managed_version_crowding",
        expect.objectContaining({ capHit: true, fetchK: 5, rejectedVersionUpperBound: 100 }),
        "user-42"
      );
    });
  });

  describe("matchToChunk — scope field propagation", () => {
    it("carries scope:'shared' from metadata into RetrievedChunk", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "sec-8k:AAPL:a1",
        score: 0.9,
        metadata: { text: "AAPL filing", scope: "shared", userId: "local" }
      });
      expect(chunk.scope).toBe("shared");
    });

    it("carries scope:'private' from metadata into RetrievedChunk", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "notes:user-42:p1",
        score: 0.8,
        metadata: { text: "Private AAPL note", scope: "private", userId: "user-42" }
      });
      expect(chunk.scope).toBe("private");
    });

    it("leaves scope undefined for legacy vectors that lack the scope field", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "legacy:AAPL:old",
        score: 0.7,
        metadata: { text: "Legacy AAPL context", userId: "local" } // no scope
      });
      expect(chunk.scope).toBeUndefined();
    });

    it("rejects unknown scope values (not 'shared' or 'private')", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "x",
        score: 0.5,
        metadata: { text: "test", scope: "admin" } // not a valid VectorScope
      });
      expect(chunk.scope).toBeUndefined();
    });
  });
});

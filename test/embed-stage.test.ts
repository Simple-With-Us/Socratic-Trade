// Durable embed stage (db-embed-stage.ts + storeContexts wiring) — the embed-once guarantee.
//
// Owner directive (2026-08-09): a paid document embedding must NEVER be paid for twice. These
// tests prove the full lifecycle: paid vectors are persisted to the embed_stage table AFTER a
// successful provider embed and BEFORE the Pinecone upsert attempt; a successful upsert deletes
// the rows; a failed upsert keeps them and the retry consumes them WITHOUT calling the embed
// provider (durably — across a simulated process restart via vi.resetModules); the monthly WU
// breaker gate still blocks everything (no embed AND no stage-consume) until it lifts; the
// retention sweep and defensive size cap bound the table; and the Float32Array BLOB roundtrip
// is exact.
//
// Scaffolding: real module graph + real temp SQLite DB (like pinecone-wu-breaker.test.ts) with
// mocked Pinecone/Voyage SDK clients (like vector-db-embedding-integrity.test.ts). VOYAGE_API_KEY
// selects the test-only voyage provider so every embed call flows through the observable mock.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-embed-stage-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-embed-stage-data-${runId}`);
});

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
    embed: vi.fn()
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

const DOCS = [
  {
    text: "AAPL 10-K risk factors: supply chain concentration in a single region.",
    metadata: { symbol: "AAPL", source: "sec-10k", timestamp: "2026-08-01T00:00:00.000Z" }
  },
  {
    text: "AAPL 10-K liquidity: strong free cash flow with rising capital returns.",
    metadata: { symbol: "AAPL", source: "sec-10k", timestamp: "2026-08-01T00:00:00.000Z" }
  }
];

const EMBED_RESPONSE = {
  data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }]
};

// Real production failure class the stage exists for: a PER-SECOND Pinecone 429 (NOT the
// monthly WU-exhaustion shape — that one trips the breaker and is tested separately below).
const TRANSIENT_UPSERT_ERROR = new Error("Pinecone upsert failed: 429 Too Many Requests (per-second rate limit)");

async function db() {
  return import("../src/lib/db");
}

async function stageRowCount(): Promise<number> {
  const { getDb } = await db();
  return (getDb().prepare("SELECT COUNT(*) AS cnt FROM embed_stage").get() as { cnt: number }).cnt;
}

async function auditRows(kind: string): Promise<Array<{ payload: string }>> {
  const { getDb } = await db();
  return getDb().prepare("SELECT payload FROM audit_events WHERE kind = ?").all(kind) as Array<{ payload: string }>;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  delete process.env.RAG_EMBED_PROVIDER;

  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.upsert.mockResolvedValue(undefined);
  mocks.embed.mockResolvedValue(EMBED_RESPONSE);

  const { getDb, applyVersionedMigrations, deleteInternalSetting } = await db();
  applyVersionedMigrations(getDb());
  getDb().prepare("DELETE FROM embed_stage").run();
  getDb().prepare("DELETE FROM audit_events").run();
  getDb().prepare("DELETE FROM api_health_log").run();
  const { PINECONE_WU_EXHAUSTED_UNTIL_KEY } = await import("../src/lib/pinecone-wu-breaker");
  deleteInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
  deleteInternalSetting("pinecone:wuGateLastAuditDay");
});

describe("Float32Array BLOB roundtrip fidelity", () => {
  it("encode -> decode is exact for f32-representable values, and equals Math.fround otherwise", async () => {
    const { encodeEmbeddingF32, decodeEmbeddingF32 } = await import("../src/lib/db-embed-stage");
    const raw = Array.from({ length: 1024 }, (_unused, i) => Math.sin(i) * (i % 7 === 0 ? -1 : 1));
    const f32Exact = raw.map((v) => Math.fround(v));

    const decodedRaw = decodeEmbeddingF32(encodeEmbeddingF32(raw), 1024)!;
    expect(decodedRaw).toEqual(f32Exact); // f64 -> f32 rounds exactly once

    const decodedExact = decodeEmbeddingF32(encodeEmbeddingF32(f32Exact), 1024)!;
    expect(decodedExact).toEqual(f32Exact); // f32-representable values roundtrip identically
  });

  it("rejects shape mismatches and non-finite payloads instead of returning garbage", async () => {
    const { encodeEmbeddingF32, decodeEmbeddingF32 } = await import("../src/lib/db-embed-stage");
    const blob = encodeEmbeddingF32([0.1, 0.2, 0.3]);
    expect(decodeEmbeddingF32(blob, 4)).toBeUndefined(); // dims/byte-length mismatch
    expect(decodeEmbeddingF32(blob, 0)).toBeUndefined();
    expect(decodeEmbeddingF32("not-a-buffer", 3)).toBeUndefined();
    expect(decodeEmbeddingF32(encodeEmbeddingF32([0.1, Infinity, 0.3]), 3)).toBeUndefined();
  });

  it("roundtrips exactly through real SQLite storage", async () => {
    const { stageEmbeddedVectors, getStagedEmbeddings } = await import("../src/lib/db-embed-stage");
    const vector = Array.from({ length: 1024 }, (_unused, i) => Math.fround(Math.cos(i) / 3));
    stageEmbeddedVectors([
      { contentHash: "hash-roundtrip", model: "m", revision: "1", vector, symbol: "AAPL", source: "t", chunkId: "c1" }
    ]);
    const found = getStagedEmbeddings(["hash-roundtrip"], "m", "1");
    expect(found.get("hash-roundtrip")).toEqual(vector);
    // Exact-key semantics: a different model or revision never matches.
    expect(getStagedEmbeddings(["hash-roundtrip"], "other-model", "1").size).toBe(0);
    expect(getStagedEmbeddings(["hash-roundtrip"], "m", "2").size).toBe(0);
  });
});

describe("storeContexts embed-once lifecycle (plain path)", () => {
  it("stages paid vectors BEFORE the upsert and deletes them after a successful upsert", async () => {
    let rowsAtUpsertTime = -1;
    mocks.upsert.mockImplementation(async () => {
      rowsAtUpsertTime = await stageRowCount();
    });

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts(structuredClone(DOCS), "local");

    expect(result.indexed).toBe(2);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // Persist-before-upsert ordering: both paid vectors were durable when the upsert ran.
    expect(rowsAtUpsertTime).toBe(2);
    // Delivered: the stage is drained after success.
    expect(await stageRowCount()).toBe(0);
    expect(result.embedsFromStage).toBeUndefined();
  });

  it("keeps rows on upsert failure and the retry consumes them WITHOUT a provider embed — durably across a restart", async () => {
    mocks.upsert.mockRejectedValueOnce(TRANSIENT_UPSERT_ERROR);

    const first = await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(first.indexed).toBe(0);
    expect(first.error).toContain("429");
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // The paid vectors survived the failure.
    expect(await stageRowCount()).toBe(2);

    // Simulate a process restart: new module graph, empty L1 process cache. The temp SQLite
    // file persists — only the durable stage can prevent a second paid embed now.
    vi.resetModules();
    mocks.embed.mockClear();
    mocks.upsert.mockClear();
    mocks.upsert.mockResolvedValue(undefined);

    const retry = await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(retry.indexed).toBe(2);
    expect(retry.embedsFromStage).toBe(2);
    expect(mocks.embed).not.toHaveBeenCalled(); // the embed was never paid for twice
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(await stageRowCount()).toBe(0); // consumed rows are deleted after delivery

    // Receipt: one embed_stage_replay audit row for the call, carrying embeds avoided.
    const replays = await auditRows("embed_stage_replay");
    expect(replays).toHaveLength(1);
    expect(JSON.parse(replays[0]!.payload)).toMatchObject({ embedsAvoided: 2, attempted: 2, indexed: 2 });
  });

  it("replays staged vectors in the reuseExactEmbeddings path too (storeDocument-style)", async () => {
    mocks.upsert.mockRejectedValueOnce(TRANSIENT_UPSERT_ERROR);
    const first = await (await import("../src/lib/vector-db")).storeContexts(
      structuredClone(DOCS),
      "local",
      { reuseExactEmbeddings: true }
    );
    expect(first.error).toBeDefined();
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(await stageRowCount()).toBe(2);

    vi.resetModules();
    mocks.embed.mockClear();
    mocks.upsert.mockClear();
    mocks.upsert.mockResolvedValue(undefined);

    const retry = await (await import("../src/lib/vector-db")).storeContexts(
      structuredClone(DOCS),
      "local",
      { reuseExactEmbeddings: true }
    );
    expect(retry.indexed).toBe(2);
    expect(retry.embedsFromStage).toBe(2);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(await stageRowCount()).toBe(0);
  });

  it("a failed retry keeps the rows staged (still zero re-embeds on the attempt after)", async () => {
    mocks.upsert.mockRejectedValue(TRANSIENT_UPSERT_ERROR);
    await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(await stageRowCount()).toBe(2);

    vi.resetModules();
    mocks.embed.mockClear();
    const retry = await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(retry.error).toBeDefined();
    expect(retry.embedsFromStage).toBe(2);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(await stageRowCount()).toBe(2); // still parked for the next retry
  });
});

describe("WU-breaker gate ordering", () => {
  it("while gated: no embed, no upsert, and NO stage consumption; the stage replays only after the gate lifts", async () => {
    // Park two paid vectors from a failed attempt.
    mocks.upsert.mockRejectedValueOnce(TRANSIENT_UPSERT_ERROR);
    await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(await stageRowCount()).toBe(2);

    // Trip the monthly breaker; every store call must now refuse BEFORE embeds AND the stage.
    process.env.PINECONE_MONTHLY_WU_BUDGET = "2000000";
    const { tripPineconeWuBreaker } = await import("../src/lib/pinecone-wu-breaker");
    const { until } = await tripPineconeWuBreaker(
      {
        message:
          "You've reached your write unit limit for the current month (2000000). Status: 429."
      },
      Date.now()
    );
    mocks.embed.mockClear();
    mocks.upsert.mockClear();

    const gated = await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(gated).toMatchObject({ attempted: 2, indexed: 0, skipped: true, wuExhausted: true, wuExhaustedUntil: until });
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(await stageRowCount()).toBe(2); // untouched — consuming while upserts must 429 would waste the replay

    // Gate lifts (marker cleared, e.g. month rolled / plan upgraded) -> staged vectors deliver
    // with zero provider embeds.
    const { deleteInternalSetting } = await db();
    const { PINECONE_WU_EXHAUSTED_UNTIL_KEY } = await import("../src/lib/pinecone-wu-breaker");
    deleteInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
    mocks.upsert.mockResolvedValue(undefined);

    const resumed = await (await import("../src/lib/vector-db")).storeContexts(structuredClone(DOCS), "local");
    expect(resumed.indexed).toBe(2);
    expect(resumed.embedsFromStage).toBe(2);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(await stageRowCount()).toBe(0);
  });
});

describe("retention sweep (disabled — forever policy)", () => {
  it("sweepEmbedStage does not delete staged rows by age or cap", async () => {
    const { stageEmbeddedVectors, sweepEmbedStage, EMBED_STAGE_RETENTION_DAYS } = await import(
      "../src/lib/db-embed-stage"
    );
    const { getDb } = await db();
    stageEmbeddedVectors([
      { contentHash: "old-1", model: "m", revision: "1", vector: [0.1, 0.2] },
      { contentHash: "fresh", model: "m", revision: "1", vector: [0.5, 0.6] }
    ]);
    const backdated = new Date(Date.now() - (EMBED_STAGE_RETENTION_DAYS + 1) * 24 * 3600_000).toISOString();
    getDb().prepare("UPDATE embed_stage SET created_at = ? WHERE content_hash = 'old-1'").run(backdated);

    const result = sweepEmbedStage();
    expect(result.expired).toBe(0);
    expect(result.capPruned).toBe(0);
    expect(await stageRowCount()).toBe(2);
  });

  it("audit-prune lane does not sweep embed_stage", async () => {
    const { stageEmbeddedVectors } = await import("../src/lib/db-embed-stage");
    const { pruneAuditEvents } = await import("../src/lib/audit-prune");
    stageEmbeddedVectors([{ contentHash: "lane-old", model: "m", revision: "1", vector: [0.1] }]);
    const result = pruneAuditEvents(new Date());
    expect(result.embedStageExpired).toBe(0);
    expect(result.embedStageCapPruned).toBe(0);
    expect(await stageRowCount()).toBe(1);
  });
});

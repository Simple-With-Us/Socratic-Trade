// Durable embed stage (db-embed-stage.ts + storeContexts wiring) — the embed-once guarantee.
//
// Owner directive (2026-08-09): a paid document embedding must NEVER be paid for twice. These
// tests prove the full lifecycle: paid vectors are persisted to the embed_stage table AFTER a
// successful provider embed and BEFORE the Pinecone upsert attempt; a successful upsert deletes
// the rows; a failed upsert keeps them and the retry consumes them WITHOUT calling the embed
// provider (durably — across a simulated process restart via vi.resetModules); the monthly WU
// breaker gate still blocks everything (no embed AND no stage-consume) until it lifts; and the
// Float32Array BLOB roundtrip is exact.
//
// ST-4540 (no data loss): removal of a staged vector requires a verified durable delivery
// receipt, the age window and size cap delete nothing (they only alarm), and an undecodable row
// is quarantined and kept for re-embed from source. Those suites are below.
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

// ─── ST-4540: staged data is never lost ───────────────────────────────────────
// Deletion requires a verified durable delivery receipt; the age window and the size cap delete
// nothing (they only alarm); an undecodable row is quarantined and kept for re-embed from source.

describe("sweep alarms without deleting (ST-4540)", () => {
  it("keeps every aged row — delivered or not — and audits the undelivered backlog", async () => {
    const { stageEmbeddedVectors, sweepEmbedStage, EMBED_STAGE_RETENTION_DAYS, deleteStagedEmbeddings } =
      await import("../src/lib/db-embed-stage");
    const { getDb } = await db();
    stageEmbeddedVectors([
      { contentHash: "old-1", model: "m", revision: "1", vector: [0.1, 0.2] },
      { contentHash: "old-2", model: "m", revision: "1", vector: [0.3, 0.4] },
      { contentHash: "fresh", model: "m", revision: "1", vector: [0.5, 0.6] }
    ]);
    // A stranded DELIVERED row (receipt written, the by-key delete never ran).
    getDb()
      .prepare("UPDATE embed_stage SET delivered_at = ?, delivered_store = 'pinecone' WHERE content_hash = 'old-1'")
      .run(new Date().toISOString());
    const backdated = new Date(Date.now() - (EMBED_STAGE_RETENTION_DAYS + 1) * 24 * 3600_000).toISOString();
    getDb().prepare("UPDATE embed_stage SET created_at = ? WHERE content_hash LIKE 'old-%'").run(backdated);

    const result = sweepEmbedStage();
    // The old sweep deleted old-1 AND old-2 here; neither is removable without a receipt+key.
    expect(result.expired).toBe(0);
    expect(result.capPruned).toBe(0);
    expect(result.undeliveredRetained).toBe(2);
    expect(await stageRowCount()).toBe(3);
    const remaining = getDb().prepare("SELECT content_hash FROM embed_stage ORDER BY content_hash").all() as Array<{
      content_hash: string;
    }>;
    expect(remaining.map((row) => row.content_hash)).toEqual(["fresh", "old-1", "old-2"]);

    // Loud: exactly one backlog audit row for the sweep (not one per row).
    const backlog = await auditRows("embed_stage_undelivered_backlog");
    expect(backlog).toHaveLength(1);
    expect(JSON.parse(backlog[0]!.payload)).toMatchObject({ undeliveredPastRetention: 1 });

    // The sanctioned removal path still works, by key, with a receipt.
    expect(deleteStagedEmbeddings(["old-2", "fresh"], "m", "1", { store: "pinecone" })).toBe(2);
    expect(await stageRowCount()).toBe(1);
  });

  it("raises exactly one over-cap alarm and deletes NOTHING", async () => {
    const { stageEmbeddedVectors, sweepEmbedStage } = await import("../src/lib/db-embed-stage");
    const { getDb } = await db();
    const vector = Array.from({ length: 256 }, (_unused, i) => i / 256); // 1 KiB per row
    for (let i = 0; i < 6; i++) {
      stageEmbeddedVectors([{ contentHash: `cap-${i}`, model: "m", revision: "1", vector }]);
      getDb().prepare("UPDATE embed_stage SET created_at = ? WHERE content_hash = ?")
        .run(new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(), `cap-${i}`);
    }
    const bytesBefore = (getDb()
      .prepare("SELECT COALESCE(SUM(LENGTH(vector)), 0) AS b FROM embed_stage").get() as { b: number }).b;

    // A cap low enough that the OLD code deleted ~4 rows oldest-first.
    const result = sweepEmbedStage(new Date(Date.UTC(2026, 7, 2)), 3_000);
    expect(result.overCap).toBe(true);
    expect(result.capPruned).toBe(0);
    expect(result.expired).toBe(0);
    expect(await stageRowCount()).toBe(6); // ALL rows kept
    const bytesAfter = (getDb()
      .prepare("SELECT COALESCE(SUM(LENGTH(vector)), 0) AS b FROM embed_stage").get() as { b: number }).b;
    expect(bytesAfter).toBe(bytesBefore);

    // One alarm audit row, and the old prune audit kind is gone for good.
    const alarm = await auditRows("embed_stage_over_cap");
    expect(alarm).toHaveLength(1);
    expect(JSON.parse(alarm[0]!.payload)).toMatchObject({ rows: 6, undelivered: 6 });
    expect(await auditRows("embed_stage_cap_prune")).toHaveLength(0);
  });

  it("short-circuits on an empty table (no scan, no alarms)", async () => {
    const { sweepEmbedStage } = await import("../src/lib/db-embed-stage");
    const { getDb } = await db();
    getDb().prepare("DELETE FROM embed_stage").run();
    expect(await stageRowCount()).toBe(0);
    // Even with a pathological cap, an empty table cannot be over it.
    const result = sweepEmbedStage(new Date(), 1);
    expect(result).toEqual({
      expired: 0,
      capPruned: 0,
      undeliveredRetained: 0,
      overCap: false,
      bytesAfter: 0
    });
    expect(await auditRows("embed_stage_over_cap")).toHaveLength(0);
    expect(await auditRows("embed_stage_undelivered_backlog")).toHaveLength(0);
  });

  it("stays quiet under the cap", async () => {
    const { stageEmbeddedVectors, sweepEmbedStage } = await import("../src/lib/db-embed-stage");
    stageEmbeddedVectors([{ contentHash: "small", model: "m", revision: "1", vector: [0.1, 0.2] }]);
    const result = sweepEmbedStage();
    expect(result.overCap).toBe(false);
    expect(result.capPruned).toBe(0);
    expect(await auditRows("embed_stage_over_cap")).toHaveLength(0);
  });

  it("the audit-prune lane reports the backlog without deleting", async () => {
    const { stageEmbeddedVectors, EMBED_STAGE_RETENTION_DAYS } = await import("../src/lib/db-embed-stage");
    const { pruneAuditEvents, pruneAuditEventsYielding } = await import("../src/lib/audit-prune");
    const { getDb } = await db();
    stageEmbeddedVectors([{ contentHash: "lane-old", model: "m", revision: "1", vector: [0.1] }]);
    getDb().prepare("UPDATE embed_stage SET created_at = ?")
      .run(new Date(Date.now() - (EMBED_STAGE_RETENTION_DAYS + 2) * 24 * 3600_000).toISOString());

    const sync = pruneAuditEvents(new Date());
    expect(sync.embedStageExpired).toBe(0);
    expect(sync.embedStageCapPruned).toBe(0);
    expect(sync.embedStageUndeliveredRetained).toBe(1);

    const yielding = await pruneAuditEventsYielding(new Date(), 5_000, async () => {});
    expect(yielding.embedStageUndeliveredRetained).toBe(1);
    expect(await stageRowCount()).toBe(1);
  });
});

describe("deleteStagedEmbeddings is gated on a delivery receipt (ST-4540)", () => {
  it("throws without a named backend instead of deleting an undelivered vector", async () => {
    const { stageEmbeddedVectors, deleteStagedEmbeddings } = await import("../src/lib/db-embed-stage");
    stageEmbeddedVectors([{ contentHash: "guarded", model: "m", revision: "1", vector: [0.1, 0.2] }]);
    // @ts-expect-error — ST-4540: the receipt is required; this is the shape the old code had.
    expect(() => deleteStagedEmbeddings(["guarded"], "m", "1")).toThrow(
      "embed_stage_delete_requires_delivery_receipt"
    );
    expect(await stageRowCount()).toBe(1); // the paid vector is still there
  });

  it("deletes only the keys it was handed, and stamps the delivery receipt", async () => {
    const { stageEmbeddedVectors, deleteStagedEmbeddings, getStagedEmbeddings } = await import(
      "../src/lib/db-embed-stage"
    );
    stageEmbeddedVectors([
      { contentHash: "a", model: "m", revision: "1", vector: [0.1] },
      { contentHash: "b", model: "m", revision: "1", vector: [0.2] }
    ]);
    expect(deleteStagedEmbeddings(["a"], "m", "1", { store: "qdrant" })).toBe(1);
    expect(await stageRowCount()).toBe(1);
    expect(getStagedEmbeddings(["b"], "m", "1").has("b")).toBe(true);
    expect(getStagedEmbeddings(["a"], "m", "1").has("a")).toBe(false);
  });

  it("a re-stage after delivery clears the receipt (the row is undelivered again)", async () => {
    const { stageEmbeddedVectors, deleteStagedEmbeddings, embedStageStats } = await import(
      "../src/lib/db-embed-stage"
    );
    const { getDb } = await db();
    stageEmbeddedVectors([{ contentHash: "restage", model: "m", revision: "1", vector: [0.1] }]);
    getDb().prepare("UPDATE embed_stage SET delivered_at = ?, delivered_store = 'pinecone'").run(new Date().toISOString());
    // A fresh paid embed for the same key supersedes the receipt.
    stageEmbeddedVectors([{ contentHash: "restage", model: "m", revision: "1", vector: [0.9] }]);
    const row = getDb().prepare("SELECT delivered_at, delivered_store FROM embed_stage").get() as {
      delivered_at: string | null;
      delivered_store: string | null;
    };
    expect(row.delivered_at).toBeNull();
    expect(row.delivered_store).toBeNull();
    expect(embedStageStats().undelivered).toBe(1);
    expect(deleteStagedEmbeddings(["restage"], "m", "1", { store: "pinecone" })).toBe(1);
  });
});

describe("undecodable staged rows are quarantined, never deleted (ST-4540)", () => {
  it("keeps a corrupt row, marks it, reports a miss, and heals on re-embed from source", async () => {
    const { stageEmbeddedVectors, getStagedEmbeddings, deleteStagedEmbeddings } = await import(
      "../src/lib/db-embed-stage"
    );
    const { getDb } = await db();
    stageEmbeddedVectors([
      { contentHash: "corrupt", model: "m", revision: "1", vector: [0.1, 0.2, 0.3] },
      { contentHash: "good", model: "m", revision: "1", vector: [0.4, 0.5, 0.6] }
    ]);
    // Corrupt the blob in place (dims still claims 3, so the shape check fails).
    getDb().prepare("UPDATE embed_stage SET vector = ? WHERE content_hash = 'corrupt'").run(Buffer.from([1, 2, 3]));

    const found = getStagedEmbeddings(["corrupt", "good"], "m", "1");
    expect(found.has("corrupt")).toBe(false); // a miss -> caller re-embeds from source
    expect(found.get("good")).toEqual([Math.fround(0.4), Math.fround(0.5), Math.fround(0.6)]);
    // The OLD code DELETED it here, losing the evidence of a paid embed.
    expect(await stageRowCount()).toBe(2);
    const row = getDb()
      .prepare("SELECT quarantined_at, quarantine_reason FROM embed_stage WHERE content_hash = 'corrupt'")
      .get() as { quarantined_at: string | null; quarantine_reason: string | null };
    expect(row.quarantined_at).not.toBeNull();
    expect(row.quarantine_reason).toContain("undecodable_vector");
    // ONE audit row for the lookup, not one per corrupt row.
    expect(await auditRows("embed_stage_quarantine")).toHaveLength(1);

    // Healing: the re-embed from source replaces the row and clears the marker.
    stageEmbeddedVectors([{ contentHash: "corrupt", model: "m", revision: "1", vector: [0.7, 0.8, 0.9] }]);
    const healed = getDb()
      .prepare("SELECT quarantined_at, quarantine_reason FROM embed_stage WHERE content_hash = 'corrupt'")
      .get() as { quarantined_at: string | null; quarantine_reason: string | null };
    expect(healed.quarantined_at).toBeNull();
    expect(healed.quarantine_reason).toBeNull();
    expect(getStagedEmbeddings(["corrupt"], "m", "1").get("corrupt")).toEqual([
      Math.fround(0.7),
      Math.fround(0.8),
      Math.fround(0.9)
    ]);
    expect(deleteStagedEmbeddings(["corrupt", "good"], "m", "1", { store: "pinecone" })).toBe(2);
    expect(await stageRowCount()).toBe(0);
  });
});

describe("embedStageStats reports the delivery backlog", () => {
  it("separates delivered, undelivered and quarantined rows", async () => {
    const { stageEmbeddedVectors, getStagedEmbeddings, embedStageStats } = await import(
      "../src/lib/db-embed-stage"
    );
    const { getDb } = await db();
    stageEmbeddedVectors([
      { contentHash: "keep-1", model: "m", revision: "1", vector: [0.1] },
      { contentHash: "keep-2", model: "m", revision: "1", vector: [0.2] }
    ]);
    getDb().prepare("UPDATE embed_stage SET vector = ? WHERE content_hash = 'keep-1'").run(Buffer.from([4]));
    getStagedEmbeddings(["keep-1"], "m", "1");

    const stats = embedStageStats();
    expect(stats.rows).toBe(2);
    expect(stats.undelivered).toBe(2); // nothing here is proven delivered
    expect(stats.quarantined).toBe(1);
    expect(stats.oldestUndeliveredCreatedAt).not.toBeNull();
    expect(stats.bytes).toBeGreaterThan(0);
  });
});

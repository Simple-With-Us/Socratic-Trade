// ST-4652: vector_doc_lifecycle write wiring. Before this change `recordVectorDocSeen`
// had zero production callers and `bumpVectorDocRetrieved` (experience-memory retrieval)
// updated rows that were never inserted, so the lifecycle table stayed empty (audit L2).
// `storeContexts` now records a first-seen row for every EPISODIC vector it actually
// upserts (doc_type socratic-decision / coach-note / lesson / experience), keyed by the
// same stable record id the retrieval bump later uses.
//
// Scaffolding mirrors test/embed-stage.test.ts: real module graph + real temp SQLite DB
// with mocked Pinecone/Voyage SDK clients.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-memory-lifecycle-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-memory-lifecycle-data-${runId}`);
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

const EXPERIENCE_DOC = {
  text: "Experience memory: closed lot with realized outcome\nticker: NVDA\nrealized_outcome: return_pct=10",
  metadata: {
    symbol: "NVDA",
    source: "experience-memory",
    accession: "exp:prop-entry-1:prop-exit-1",
    timestamp: "2026-08-01T00:00:00.000Z",
    doc_type: "socratic-decision",
    memory_kind: "experience"
  }
};

const FILING_DOC = {
  text: "AAPL 10-K risk factors: supply chain concentration in a single region.",
  metadata: { symbol: "AAPL", source: "sec-10k", timestamp: "2026-08-01T00:00:00.000Z", doc_type: "10-k" }
};

async function db() {
  return import("../src/lib/db");
}

interface LifecycleRow {
  user_id: string;
  vector_id: string;
  doc_type: string;
  first_seen_at: string;
  last_retrieved_at: string | null;
  retrieval_count: number;
  archived_at: string | null;
}

async function lifecycleRows(): Promise<LifecycleRow[]> {
  const { getDb } = await db();
  return getDb()
    .prepare(
      "SELECT user_id, vector_id, doc_type, first_seen_at, last_retrieved_at, retrieval_count, archived_at FROM vector_doc_lifecycle ORDER BY vector_id"
    )
    .all() as LifecycleRow[];
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
  mocks.embed.mockImplementation(async (args: { input: string[] }) => ({
    data: args.input.map((_, i) => ({ embedding: [0.1 * (i + 1), 0.2, 0.3] }))
  }));

  const { getDb, applyVersionedMigrations } = await db();
  applyVersionedMigrations(getDb());
  // The drop-table failure-isolation test removes the table; the migration runner will
  // not recreate it (version 80 is already recorded), so restore migration 80's DDL here.
  getDb().exec(
    "CREATE TABLE IF NOT EXISTS vector_doc_lifecycle (user_id TEXT NOT NULL, vector_id TEXT NOT NULL, doc_type TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_retrieved_at TEXT, retrieval_count INTEGER NOT NULL DEFAULT 0, archived_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, vector_id))"
  );
  getDb().prepare("DELETE FROM vector_doc_lifecycle").run();
});

describe("storeContexts -> vector_doc_lifecycle (ST-4652)", () => {
  it("records one first-seen row for an episodic write, keyed by the upserted record id", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([structuredClone(EXPERIENCE_DOC)], "local", {
      dedupKeyPrefix: "experience-memory",
      scope: "private"
    });
    expect(result.indexed).toBe(1);

    const upsertedId = (mocks.upsert.mock.calls[0]![0] as { records: Array<{ id: string }> }).records[0]!.id;
    // The stable plain-path id: source:symbol:accession:timestamp (contextId).
    expect(upsertedId).toBe("experience-memory:NVDA:exp:prop-entry-1:prop-exit-1:2026-08-01T00:00:00.000Z");

    const rows = await lifecycleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "local",
      vector_id: upsertedId,
      doc_type: "socratic-decision",
      retrieval_count: 0,
      last_retrieved_at: null,
      archived_at: null
    });
    expect(rows[0]!.first_seen_at).toBeTruthy();
  });

  it("dedupes on a repeated episodic write: still one row, first_seen_at preserved", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([structuredClone(EXPERIENCE_DOC)], "local", { scope: "private" });
    const first = await lifecycleRows();
    expect(first).toHaveLength(1);

    // Backdate first_seen_at to a sentinel the second write must not clobber.
    const { getDb } = await db();
    getDb()
      .prepare("UPDATE vector_doc_lifecycle SET first_seen_at = ?")
      .run("2026-01-01T00:00:00.000Z");

    const second = await storeContexts([structuredClone(EXPERIENCE_DOC)], "local", { scope: "private" });
    expect(second.indexed).toBe(1);
    const rows = await lifecycleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[0]!.retrieval_count).toBe(0);
  });

  it("does NOT record lifecycle rows for non-episodic (filing) vectors", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([structuredClone(FILING_DOC)], "local");
    expect(result.indexed).toBe(1);
    expect(await lifecycleRows()).toHaveLength(0);
  });

  it("the recorded row is the one the retrieval bump increments", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([structuredClone(EXPERIENCE_DOC)], "local", { scope: "private" });
    const [row] = await lifecycleRows();

    const { bumpVectorDocRetrieved } = await import("../src/lib/db-memory-lifecycle");
    bumpVectorDocRetrieved({ userId: "local", vectorIds: [row!.vector_id], now: "2026-11-22T00:00:00.000Z" });

    const after = await lifecycleRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.retrieval_count).toBe(1);
    expect(after[0]!.last_retrieved_at).toBe("2026-11-22T00:00:00.000Z");
  });

  it("lifecycle write failure (table missing) never breaks memory storage", async () => {
    // Simulate an unmigrated DB: the lifecycle INSERT will throw inside storeContexts.
    // Storage must still succeed -- the lifecycle table is additive bookkeeping.
    const { getDb } = await db();
    getDb().exec("DROP TABLE vector_doc_lifecycle");

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([structuredClone(EXPERIENCE_DOC)], "local", { scope: "private" });
    expect(result.indexed).toBe(1);
    expect(result.error).toBeUndefined();
    expect(mocks.upsert).toHaveBeenCalled();
  });
});

describe("db-memory-lifecycle CRUD dedupe", () => {
  it("recordVectorDocSeen upserts on (user_id, vector_id) without duplicate rows", async () => {
    const { recordVectorDocSeen, listLiveVectorDocLifecycle } = await import("../src/lib/db-memory-lifecycle");
    recordVectorDocSeen({ userId: "u1", vectorId: "v1", docType: "lesson", now: "2026-01-01T00:00:00.000Z" });
    recordVectorDocSeen({ userId: "u1", vectorId: "v1", docType: "lesson", now: "2026-06-01T00:00:00.000Z" });
    const rows = listLiveVectorDocLifecycle("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[0]!.updatedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

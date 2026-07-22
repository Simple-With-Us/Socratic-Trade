import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real temp SQLite DB (never the dev data/app.db) — set BEFORE any dynamic import touches db.ts,
// mirroring test/vector-db-document-receipts.test.ts's pattern exactly.
process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-corpus-reembed-${randomUUID()}.db`)}`;
process.env.ENCRYPTION_KEY = "0".repeat(64);

const mocks = vi.hoisted(() => {
  const upsert = vi.fn(async (_input: {
    records: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>;
  }) => undefined);
  const listPaginated = vi.fn(async () => ({ vectors: [], pagination: undefined }));
  const fetchRecords = vi.fn(async () => ({ records: {} }));
  const deleteMany = vi.fn(async () => undefined);
  const namespacedIndex = {
    upsert,
    query: vi.fn(async () => ({ matches: [] })),
    listPaginated,
    fetch: fetchRecords,
    deleteMany
  };
  const index = vi.fn(() => ({
    ...namespacedIndex,
    namespace: vi.fn(() => namespacedIndex)
  }));
  return {
    upsert,
    listPaginated,
    fetchRecords,
    deleteMany,
    index,
    listIndexes: vi.fn(async () => ({ indexes: [{ name: "socratic-trade" }] })),
    createIndex: vi.fn(async () => undefined),
    describeIndex: vi.fn(async () => ({ dimension: 1024, metric: "cosine" })),
    embed: vi.fn(async (input: { input: string[] }) => ({
      data: (input?.input ?? [""]).map((_, i) => ({ embedding: [0.1 + i, 0.2 + i] }))
    }))
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

beforeAll(async () => {
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "off";
  process.env.HYBRID_RETRIEVAL = "off";
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 180_000);

afterAll(() => {
  for (const key of [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "PINECONE_API_KEY",
    "VOYAGE_API_KEY",
    "PINECONE_INDEX_READY_WAIT_MS",
    "VECTOR_EMBED_BATCH_DELAY_MS",
    "VECTOR_ENABLE_RERANK",
    "HYBRID_RETRIEVAL"
  ]) delete process.env[key];
});

afterEach(() => {
  for (const key of [
    "RAG_INGEST_BUDGET_ENABLED",
    "RAG_INGEST_MAX_TEXTS_PER_DAY",
    "RAG_PINECONE_WRITE_BUDGET_ENABLED",
    "RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY"
  ]) delete process.env[key];
});

beforeEach(async () => {
  mocks.upsert.mockClear();
  mocks.embed.mockClear();
  mocks.deleteMany.mockClear();
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  // This suite intentionally reuses one temp database so a single test can exercise resume and
  // receipt reuse. Keep each test's source corpus isolated, though: unscoped runs must not inherit
  // SEC rows inserted by earlier cases in this file.
  db.prepare("DELETE FROM document_chunks_fts").run();
  db.prepare("DELETE FROM sec_filings").run();
  const { resetOperationLeaseForTest } = await import("../src/lib/operation-lease");
  resetOperationLeaseForTest();
});

/** Installs a per-user "openrouter" API key so `activeEmbeddingModel` returns "baai/bge-m3".
 *  `openrouter` is a per-user-only credential tier (db-api-keys.ts API_KEY_TIER — no env
 *  fallback), so a stored per-user key row is the supported way to flip the active model here. */
async function activateBgeM3(): Promise<void> {
  const { upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "fake-openrouter-key-for-tests");
}

async function deactivateBgeM3(): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  getDb().prepare("DELETE FROM user_api_keys WHERE user_id = 'local' AND service = 'openrouter'").run();
}

async function insertSecFilingChunk(row: {
  contentHash: string;
  symbol: string;
  accession: string;
  text: string;
  form: string;
  filedAt: string;
}): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  db.prepare(`
    INSERT INTO document_chunks_fts (content_hash, symbol, source, accession, text)
    VALUES (?, ?, 'sec-edgar', ?, ?)
  `).run(row.contentHash, row.symbol, row.accession, row.text);
  db.prepare(`
    INSERT OR IGNORE INTO sec_filings (accession, cik, ticker, form, filed_at, accepted_at, status, chunk_count, created_at, updated_at)
    VALUES (?, '0000320193', ?, ?, ?, ?, 'complete', 1, ?, ?)
  `).run(row.accession, row.symbol, row.form, row.filedAt, row.filedAt, row.filedAt, row.filedAt);
}

describe("corpus-reembed", () => {
  it("pushes FTS-sourced SEC filing text through storeDocument into the active (bge-m3) space", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest } = await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-flip-1",
      symbol: "FLIP",
      accession: "0000320193-26-000001",
      text: "Management discussed durable revenue growth and margin expansion for FLIP Corp.",
      form: "10-K",
      filedAt: "2026-02-01T00:00:00.000Z"
    });

    await activateBgeM3();
    const run = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["FLIP"] });
    expect(run.acquired).toBe(true);
    const secResult = run.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(secResult.embedded).toBe(1);
    expect(secResult.reusedInSpace).toBe(0);
    expect(secResult.failed).toBe(0);
    expect(secResult.completed).toBe(true);
    expect(run.result!.embedModel).toBe("baai/bge-m3");
    expect(run.result!.embedRevision).toBe("v1-baai-bge-m3");

    // The committed (second-phase) Pinecone record must be stamped into the bge-m3 space.
    const committedCall = mocks.upsert.mock.calls.find((call) =>
      (call[0].records as Array<{ metadata: Record<string, unknown> }>).some(
        (r) => r.metadata.ingest_state === "committed"
      )
    );
    expect(committedCall).toBeDefined();
    const committedRecord = (committedCall![0].records as Array<{ id: string; metadata: Record<string, unknown> }>).find(
      (r) => r.metadata.ingest_state === "committed"
    )!;
    expect(committedRecord.metadata.embed_model).toBe("baai/bge-m3");
    expect(committedRecord.metadata.embed_revision).toBe("v1-baai-bge-m3");
    // (The vector id's embed-revision component is SHA-hashed into the occ:v3 token form, so the
    // id-collision isolation itself is covered by construction + embedding-space-isolation.test.ts,
    // not by a substring assertion here.)
  });

  it("rerun skips already-re-embedded content (idempotency) with no additional embed/upsert", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest } = await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-idem-1",
      symbol: "IDEM",
      accession: "0000320193-26-000002",
      text: "Idempotency test filing text for IDEM Corp, distinct from other fixtures.",
      form: "10-K",
      filedAt: "2026-02-02T00:00:00.000Z"
    });
    await activateBgeM3();

    const first = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["IDEM"] });
    const firstSec = first.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(firstSec.embedded).toBe(1);
    const upsertsAfterFirst = mocks.upsert.mock.calls.length;
    const embedsAfterFirst = mocks.embed.mock.calls.length;
    expect(upsertsAfterFirst).toBeGreaterThan(0);

    // Clear the watermark to force a full re-scan (the harder idempotency case — a plain rerun
    // would already skip via the watermark without ever reaching storeDocument). The re-scan must
    // resolve entirely from storeDocument's committed local receipt (the commit id embeds the
    // embedding-space revision) — zero provider traffic.
    resetCorpusReembedStateForTest();
    const second = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["IDEM"] });
    const secondSec = second.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(secondSec.candidatesSeen).toBe(1);
    expect(secondSec.embedded).toBe(0);
    expect(secondSec.reusedInSpace).toBe(1);
    expect(secondSec.failed).toBe(0);
    expect(mocks.upsert.mock.calls.length).toBe(upsertsAfterFirst);
    expect(mocks.embed.mock.calls.length).toBe(embedsAfterFirst);
  });

  it("stops cleanly on budget exhaustion mid-run and resumes from the persisted watermark", async () => {
    await deactivateBgeM3(); // plain Voyage path; usage accounting is identical for both models
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, getCorpusReembedProgress } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    // Earlier tests in this file already booked voyage embed usage into the shared temp DB;
    // clear it so the 1-text/day fuse below starts from zero used.
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM rag_usage").run();
    await insertSecFilingChunk({
      contentHash: "hash-budget-1",
      symbol: "BUDG",
      accession: "0000320193-26-000003",
      text: "First budget-test filing chunk for BUDG Corp, should embed successfully.",
      form: "10-K",
      filedAt: "2026-02-03T00:00:00.000Z"
    });
    await insertSecFilingChunk({
      contentHash: "hash-budget-2",
      symbol: "BUDG",
      accession: "0000320193-26-000004",
      text: "Second budget-test filing chunk for BUDG Corp, deferred by the daily fuse.",
      form: "10-K",
      filedAt: "2026-02-04T00:00:00.000Z"
    });

    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    const run = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["BUDG"] });
    const secResult = run.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(run.result!.stoppedForBudget).toBe(true);
    expect(secResult.stoppedForBudget).toBe(true);
    expect(secResult.embedded).toBe(1);
    expect(secResult.completed).toBe(false);

    // Watermark persisted at the last successfully processed row — consistent, resumable state.
    const progressAfterStop = getCorpusReembedProgress().persisted;
    const scopedProgress = Object.values(progressAfterStop?.scopedRuns ?? {})[0]?.docTypes?.["sec-filings"];
    expect(scopedProgress?.status).toBe("stopped-budget");
    const watermark = scopedProgress?.watermark as { rowid: number } | null;
    expect(watermark?.rowid).toBeGreaterThan(0);

    // Lift the fuse and rerun: only the deferred second chunk embeds (the first is already
    // committed and would be reused if revisited — but the watermark skips straight past it).
    delete process.env.RAG_INGEST_MAX_TEXTS_PER_DAY;
    const resumed = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["BUDG"] });
    const resumedSec = resumed.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(resumedSec.embedded).toBe(1);
    expect(resumedSec.completed).toBe(true);
    expect(resumed.result!.stoppedForBudget).toBe(false);
  });

  it("dry-run returns counts without embedding and without advancing watermarks", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedDryRun, getCorpusReembedProgress } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-dry-1",
      symbol: "DRYR",
      accession: "0000320193-26-000005",
      text: "Dry-run-only filing chunk for DRYR Corp; must never be embedded.",
      form: "10-K",
      filedAt: "2026-02-05T00:00:00.000Z"
    });
    await activateBgeM3();

    const guarded = await runCorpusReembedDryRun({ docTypes: ["sec-filings"], symbols: ["DRYR"] });
    expect(guarded.acquired).toBe(true);
    expect(guarded.result!.dryRun).toBe(true);
    const secResult = guarded.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(secResult.candidatesSeen).toBe(1);
    expect(secResult.embedded).toBe(1); // "would embed" — not committed in this space yet
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();

    // Strictly read-only: nothing persisted, so a later real run still processes everything.
    expect(getCorpusReembedProgress().persisted).toBeUndefined();
  });

  it("dry-run counts already-committed current-space content as reused, not re-embed work", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, runCorpusReembedDryRun } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-dry-reuse-1",
      symbol: "DRYX",
      accession: "0000320193-26-000007",
      text: "Dry-run-reuse filing chunk for DRYX Corp; embedded first, then dry-run-counted.",
      form: "10-K",
      filedAt: "2026-02-07T00:00:00.000Z"
    });
    await activateBgeM3();
    await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["DRYX"] });
    const { resetCorpusReembedStateForTest: resetAgain } = await import("../src/lib/rag/corpus-reembed");
    resetAgain(); // clear watermarks so the dry run re-scans from the beginning

    const guarded = await runCorpusReembedDryRun({ docTypes: ["sec-filings"], symbols: ["DRYX"] });
    const secResult = guarded.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(secResult.candidatesSeen).toBe(1);
    expect(secResult.reusedInSpace).toBe(1);
    expect(secResult.embedded).toBe(0);
  });

  it("refuses legacy-space purge until re-embed reports complete for the covered docTypes", async () => {
    const { resetCorpusReembedStateForTest, purgeLegacyEmbeddingSpace } = await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await activateBgeM3(); // purge is only meaningful once a non-Voyage space is active

    const guarded = await purgeLegacyEmbeddingSpace({ docTypes: ["sec-filings"], confirm: "purge-voyage-vectors" });
    expect(guarded.acquired).toBe(true);
    expect(guarded.result!.ok).toBe(false);
    expect(guarded.result!.refused).toMatch(/has not completed/);
    expect(guarded.result!.purged).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("does not let a symbol-scoped re-embed authorize full legacy purge", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, purgeLegacyEmbeddingSpace } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-scoped-purge-1",
      symbol: "SCOP",
      accession: "0000320193-26-000008",
      text: "Scoped re-embed filing chunk for SCOP Corp; not proof the full corpus is complete.",
      form: "10-K",
      filedAt: "2026-02-08T00:00:00.000Z"
    });
    await activateBgeM3();

    const scopedRun = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["SCOP"] });
    const secResult = scopedRun.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(secResult.completed).toBe(true);

    const purge = await purgeLegacyEmbeddingSpace({ docTypes: ["sec-filings"], confirm: "purge-voyage-vectors" });
    expect(purge.acquired).toBe(true);
    expect(purge.result!.ok).toBe(false);
    expect(purge.result!.refused).toMatch(/has not completed/);
    expect(purge.result!.purged).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps scoped watermarks separate so a later full run cannot skip earlier symbols", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, getCorpusReembedProgress } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-full-before-scope",
      symbol: "MSFT",
      accession: "0000320193-26-000009",
      text: "Earlier full-corpus row that a later AAPL-scoped watermark must never skip.",
      form: "10-K",
      filedAt: "2026-02-09T00:00:00.000Z"
    });
    await insertSecFilingChunk({
      contentHash: "hash-scope-after-full",
      symbol: "AAPL",
      accession: "0000320193-26-000010",
      text: "Later AAPL row used to prove scoped progress is isolated from the full corpus.",
      form: "10-K",
      filedAt: "2026-02-10T00:00:00.000Z"
    });
    await activateBgeM3();

    const scoped = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["AAPL"] });
    expect(scoped.result!.docTypes[0].candidatesSeen).toBe(1);

    const full = await runCorpusReembedForTest({ docTypes: ["sec-filings"] });
    expect(full.result!.docTypes[0]).toMatchObject({ candidatesSeen: 2, embedded: 1, reusedInSpace: 1, completed: true });
    const progress = getCorpusReembedProgress().persisted!;
    expect(progress.docTypes["sec-filings"]?.completedForEmbedRevision).toBe("v1-baai-bge-m3");
    expect(Object.values(progress.scopedRuns ?? {})).toHaveLength(1);
  });

  it("preserves valid full-corpus completion proof across later scoped maintenance", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, getCorpusReembedProgress } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-preserve-full-proof",
      symbol: "KEEP",
      accession: "0000320193-26-000011",
      text: "A completed full-corpus row whose purge proof must survive scoped maintenance.",
      form: "10-K",
      filedAt: "2026-02-11T00:00:00.000Z"
    });
    await activateBgeM3();

    await runCorpusReembedForTest({ docTypes: ["sec-filings"] });
    const before = getCorpusReembedProgress().persisted!.docTypes["sec-filings"]!;
    await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["KEEP"] });
    const after = getCorpusReembedProgress().persisted!.docTypes["sec-filings"]!;

    expect(after).toEqual(before);
    expect(after.completedForEmbedRevision).toBe("v1-baai-bge-m3");
  });

  it("refuses purge on wrong confirm token and while Voyage is still the active model", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, purgeLegacyEmbeddingSpace } =
      await import("../src/lib/rag/corpus-reembed");
    resetCorpusReembedStateForTest();
    await insertSecFilingChunk({
      contentHash: "hash-purge-1",
      symbol: "PRGC",
      accession: "0000320193-26-000006",
      text: "Purge-confirm-token filing chunk for PRGC Corp.",
      form: "10-K",
      filedAt: "2026-02-06T00:00:00.000Z"
    });
    await activateBgeM3();
    await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["PRGC"] });

    // Wrong token: refused even though the run completed for this docType.
    const wrongToken = await purgeLegacyEmbeddingSpace({ docTypes: ["sec-filings"], confirm: "wrong-token" });
    expect(wrongToken.result!.ok).toBe(false);
    expect(wrongToken.result!.refused).toMatch(/confirm/);

    // Voyage still active: refused outright (would delete the current space).
    await deactivateBgeM3();
    const voyageActive = await purgeLegacyEmbeddingSpace({ docTypes: ["sec-filings"], confirm: "purge-voyage-vectors" });
    expect(voyageActive.result!.ok).toBe(false);
    expect(voyageActive.result!.refused).toMatch(/voyage-finance-2/);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    await activateBgeM3();
  });
});

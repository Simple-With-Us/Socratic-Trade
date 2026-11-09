import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-vector-receipts-${randomUUID()}.db`)}`;

const mocks = vi.hoisted(() => {
  const upsert = vi.fn(async (_input: {
    records: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>;
  }) => undefined);
  const listPaginated = vi.fn();
  const fetchRecords = vi.fn();
  const update = vi.fn(async () => undefined);
  const deleteMany = vi.fn(async () => undefined);
  const namespacedIndex = {
    upsert,
    query: vi.fn(),
    listPaginated,
    fetch: fetchRecords,
    update,
    deleteMany
  };
  const index = vi.fn(() => ({
    ...namespacedIndex,
    namespace: vi.fn(() => namespacedIndex)
  }));
  return {
    upsert,
    index,
    listPaginated,
    fetchRecords,
    update,
    deleteMany,
    listIndexes: vi.fn(async () => ({ indexes: [{ name: "socratic-trade" }] })),
    createIndex: vi.fn(async () => undefined),
    describeIndex: vi.fn(async () => ({ dimension: 1024, metric: "cosine" })),
    embed: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] }] }))
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
}, 60_000);

afterAll(() => {
  for (const key of [
    "DATABASE_URL",
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

describe("storeDocument receipt transaction", () => {
  it("rolls back document_chunks when chunk_occurrences fails, then completes idempotently", async () => {
    const { getDb } = await import("../src/lib/db");
    const { managedVectorLedgerAuthority, storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    db.exec(`
      CREATE TRIGGER fail_test_chunk_occurrence
      BEFORE INSERT ON chunk_occurrences
      BEGIN
        SELECT RAISE(ABORT, 'synthetic chunk occurrence fault');
      END;
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = {
      text: "Management discussed revenue growth, durable demand, and margin expansion.",
      doc_id: "FMP-EARNINGS-TRANSCRIPT:AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL earnings call 2026 Q1",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20T20:00:00.000Z",
      acceptance_datetime: "2026-04-21T01:00:00.000Z"
    };

    const failed = await storeDocument(input);
    expect(failed).toMatchObject({
      indexed: 1,
      error: "document-receipt-write-failed",
      documentComplete: false
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_chunks").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences").get()).toEqual({ count: 0 });

    db.exec("DROP TRIGGER fail_test_chunk_occurrence");
    const completed = await storeDocument(input);
    expect(completed).toMatchObject({ attempted: 1, indexed: 1, documentComplete: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_chunks").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences").get()).toEqual({ count: 1 });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // Failed receipt: pending upsert only. Successful retry: pending + committed upserts.
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    const committedRecord = mocks.upsert.mock.calls.at(-1)![0].records[0];
    expect(committedRecord.metadata).toMatchObject({
      ingest_state: "committed",
      receipt_required: true,
      tenant_scope: "shared:operator",
      parser_revision: "v1",
      embed_revision: "v1",
      ledger_authority: managedVectorLedgerAuthority(),
      vector_namespace: "fmp-transcripts",
      chunk_ordinal: 1
    });
    expect(db.prepare(`
      SELECT c.state AS commit_state, o.receipt_state
      FROM vector_ingest_commits c
      JOIN chunk_occurrences o ON o.commit_id = c.id
    `).get()).toEqual({ commit_state: "committed", receipt_state: "committed" });

    const commit = db.prepare(`
      SELECT id, tenant_scope, user_id, source, accession, document_key, content_version,
             retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
             provider_authority, ledger_authority, vector_namespace
      FROM vector_ingest_commits
      WHERE accession = ?
    `).get(input.doc_id) as {
      id: string;
      tenant_scope: string;
      user_id: string;
      source: string;
      accession: string;
      document_key: string;
      content_version: string;
      retrieval_metadata_version: string;
      parser_revision: string;
      embed_revision: string;
      expected_vectors: number;
      provider_authority: string | null;
      ledger_authority: string | null;
      vector_namespace: "managed" | "fmp-transcripts";
    };
    const { beginVectorCommit } = await import("../src/lib/db");
    const committedIdentity = {
      id: commit.id,
      tenantScope: commit.tenant_scope,
      userId: commit.user_id,
      source: commit.source,
      accession: commit.accession,
      documentKey: commit.document_key,
      contentVersion: commit.content_version,
      retrievalMetadataVersion: commit.retrieval_metadata_version,
      parserRevision: commit.parser_revision,
      embedRevision: commit.embed_revision,
      expectedVectors: commit.expected_vectors,
      providerAuthority: commit.provider_authority ?? undefined,
      ledgerAuthority: commit.ledger_authority ?? undefined,
      vectorNamespace: commit.vector_namespace
    };
    const otherLedgerAuthority = `${managedVectorLedgerAuthority()}:other`;
    expect(beginVectorCommit({
      ...committedIdentity,
      attemptToken: "replay-must-not-replace-committed",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    })).toBe("already_committed");
    expect(() => beginVectorCommit({
      ...committedIdentity,
      expectedVectors: commit.expected_vectors + 1,
      attemptToken: "committed-identity-mismatch",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    })).toThrow("Vector commit identity mismatch");
    expect(() => beginVectorCommit({
      ...committedIdentity,
      ledgerAuthority: otherLedgerAuthority,
      attemptToken: "committed-ledger-authority-mismatch",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    })).toThrow("Vector commit identity mismatch");
    expect(() => beginVectorCommit({
      ...committedIdentity,
      vectorNamespace: commit.vector_namespace === "managed" ? "fmp-transcripts" : "managed",
      attemptToken: "committed-namespace-mismatch",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    })).toThrow("Vector commit identity mismatch");
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commit.id))
      .toEqual({ state: "committed" });

    // A deterministic replay reuses the exact committed set before consulting provider budgets.
    const embedCallsBeforeReplay = mocks.embed.mock.calls.length;
    const upsertCallsBeforeReplay = mocks.upsert.mock.calls.length;
    process.env.RAG_INGEST_BUDGET_ENABLED = "on";
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    const replayed = await storeDocument(input);
    expect(replayed).toMatchObject({
      attempted: 1,
      indexed: 0,
      skipped: true,
      reusedCommitted: true,
      documentComplete: true
    });
    expect(mocks.embed).toHaveBeenCalledTimes(embedCallsBeforeReplay);
    expect(mocks.upsert).toHaveBeenCalledTimes(upsertCallsBeforeReplay);
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commit.id))
      .toEqual({ state: "committed" });

    const { filterMatchesForCommittedReceipts } = await import("../src/lib/vector-db");
    const providerAuthority = String(committedRecord.metadata.provider_authority);
    const ledgerAuthority = String(committedRecord.metadata.ledger_authority);
    const receiptAuthority = { userId: "local", providerAuthority, ledgerAuthority };
    expect(filterMatchesForCommittedReceipts([{ ...committedRecord, score: 0.9 }], undefined, receiptAuthority))
      .toHaveLength(1);
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: { ...committedRecord.metadata, symbol: "MSFT" },
      score: 0.9
    }], undefined, receiptAuthority)).toEqual([]);
    const markerlessMetadata = Object.fromEntries(
      Object.entries(committedRecord.metadata).filter(([key]) => key !== "receipt_required")
    );
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: markerlessMetadata,
      score: 0.9
    }], undefined, receiptAuthority)).toEqual([]);
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: { ...committedRecord.metadata, provider_authority: "other-provider" },
      score: 0.9
    }], undefined, receiptAuthority)).toEqual([]);
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: { ...committedRecord.metadata, ledger_authority: otherLedgerAuthority },
      score: 0.9
    }], undefined, receiptAuthority)).toEqual([]);
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: { ...committedRecord.metadata, vector_namespace: "managed" },
      score: 0.9
    }], undefined, receiptAuthority)).toEqual([]);
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: { ...committedRecord.metadata, scope: "private" },
      score: 0.9
    }], undefined, receiptAuthority)).toEqual([]);
    expect(filterMatchesForCommittedReceipts(
      [{ ...committedRecord, score: 0.9 }],
      undefined,
      { userId: "local", providerAuthority: "other-provider" }
    )).toEqual([]);
    expect(filterMatchesForCommittedReceipts(
      [{ ...committedRecord, score: 0.9 }],
      undefined,
      { userId: "local", providerAuthority, ledgerAuthority: otherLedgerAuthority }
    )).toEqual([]);
    // Fail closed on an UNKNOWN authority, not just a wrong one.  With nothing to compare
    // `metadata.provider_authority` / `receipt.providerAuthority` against there is no way to prove
    // a managed record belongs to this deployment's index, so none is admissible — while unrelated
    // legacy/direct records still pass.  (Qdrant read cutover, #3138/#3158 follow-up.)
    const legacyDirectMatch = {
      id: "sec-filings:AAPL:10-k:2026:chunk-1",
      metadata: { symbol: "AAPL", scope: "shared", tenant_scope: "shared:operator", userId: "local" },
      score: 0.4
    };
    for (const missingAuthority of [
      undefined,
      { userId: "local", ledgerAuthority },
      { userId: "local", providerAuthority: "", ledgerAuthority }
    ]) {
      expect(filterMatchesForCommittedReceipts(
        [{ ...committedRecord, score: 0.9 }],
        undefined,
        missingAuthority
      )).toEqual([]);
      expect(filterMatchesForCommittedReceipts(
        [legacyDirectMatch],
        undefined,
        missingAuthority
      )).toEqual([legacyDirectMatch]);
    }

    // INSERT OR IGNORE must not turn a stale/conflicting prior occurrence into a false completion.
    db.prepare("UPDATE chunk_occurrences SET content_hash = 'stale-conflict'").run();
    const conflicted = await storeDocument(input);
    expect(conflicted).toMatchObject({
      indexed: 0,
      error: "document-committed-receipt-integrity-mismatch",
      documentComplete: false
    });
    expect(mocks.embed).toHaveBeenCalledTimes(embedCallsBeforeReplay);
    expect(mocks.upsert).toHaveBeenCalledTimes(upsertCallsBeforeReplay);
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commit.id))
      .toEqual({ state: "committed" });
    warn.mockRestore();
  });

  it("attributes a LOCAL SQLite receipt fault to local contention, not to the vector store", async () => {
    // The receipt/finalize seams rethrow as `new Error("document-…-failed", { cause: sqliteError })`,
    // so the raw SQLite text is only reachable through the CAUSE. Before this was walked, a local
    // write-lock fault surfaced as an error-level "RAG vector store failed" Sentry event blaming
    // Pinecone — the same mislabel class as the 2026-08-09 "Pinecone connection failed / database
    // is locked" pushes. Control flow is unaffected: the caller still gets the same wrapper error.
    //
    // The trigger raises the literal SQLITE_BUSY message text rather than holding a real write
    // lock, for the reason this repo already documents in local-db-fault-classification.test.ts:
    // a genuine held lock would also block the classifier's own audit write.
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    db.prepare("DELETE FROM audit_events WHERE kind = 'local_db_contention'").run();
    db.exec(`
      CREATE TRIGGER fail_test_local_db_lock
      BEFORE INSERT ON chunk_occurrences
      BEGIN
        SELECT RAISE(ABORT, 'database is locked');
      END;
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await storeDocument({
        text: "Local contention probe: the receipt write is the thing that fails here.",
        doc_id: "LOCAL-DB-FAULT-PROBE:NVDA:2026:Q2",
        ticker: "NVDA",
        title: "NVDA local-fault probe",
        doc_type: "earnings-transcript",
        source: "fmp-earnings-transcript",
        published_at: "2026-05-20T20:00:00.000Z",
        acceptance_datetime: "2026-05-21T01:00:00.000Z"
      });
      expect(failed.error).toBe("document-receipt-write-failed");

      const row = db
        .prepare("SELECT payload FROM audit_events WHERE kind = 'local_db_contention' ORDER BY rowid DESC LIMIT 1")
        .get() as { payload: string } | undefined;
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload) as { lane: string; operation: string; reason: string };
      expect(payload.lane).toBe("vector-store");
      expect(payload.operation).toBe("storeContexts");
      // The RAW SQLite text, not the opaque "document-receipt-write-failed" wrapper label.
      expect(payload.reason).toContain("database is locked");
    } finally {
      db.exec("DROP TRIGGER fail_test_local_db_lock");
      warn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("does not create a pending commit for whitespace-only input", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    const before = db.prepare("SELECT COUNT(*) AS count FROM vector_ingest_commits").get() as { count: number };
    const embedCalls = mocks.embed.mock.calls.length;
    const upsertCalls = mocks.upsert.mock.calls.length;

    const stored = await storeDocument({
      text: "  \n\t  ",
      doc_id: `EMPTY:${randomUUID()}`,
      ticker: "AAPL",
      title: "empty",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-07-14T12:00:00.000Z"
    });

    expect(stored).toEqual({ attempted: 0, indexed: 0, documentComplete: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_ingest_commits").get()).toEqual(before);
    expect(mocks.embed).toHaveBeenCalledTimes(embedCalls);
    expect(mocks.upsert).toHaveBeenCalledTimes(upsertCalls);
  });

  it("serializes concurrent calls for the same deterministic commit", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const accession = `CONCURRENT:${randomUUID()}`;
    const input = {
      text: `Concurrent managed document ${randomUUID()} with material financial context.`,
      doc_id: accession,
      ticker: "MSFT",
      title: "MSFT concurrent filing",
      doc_type: "10-q",
      source: "sec-edgar",
      published_at: "2026-07-14T12:00:00.000Z",
      acceptance_datetime: "2026-07-14T12:00:01.000Z"
    };
    let releaseEmbed!: () => void;
    let signalEmbedStarted!: () => void;
    const embedStarted = new Promise<void>((resolve) => {
      signalEmbedStarted = resolve;
    });
    const embedGate = new Promise<void>((resolve) => {
      releaseEmbed = resolve;
    });
    mocks.embed.mockClear();
    mocks.upsert.mockClear();
    mocks.embed.mockImplementationOnce(async () => {
      signalEmbedStarted();
      await embedGate;
      return { data: [{ embedding: [0.1, 0.2] }] };
    });

    const first = storeDocument(input);
    await embedStarted;
    const second = storeDocument(input);
    await Promise.resolve();
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    releaseEmbed();
    const results = await Promise.all([first, second]);

    expect(results).toContainEqual(expect.objectContaining({ indexed: 1, documentComplete: true }));
    expect(results).toContainEqual(expect.objectContaining({
      indexed: 0,
      reusedCommitted: true,
      documentComplete: true
    }));
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      WHERE c.accession = ? AND c.state = 'committed' AND o.receipt_state = 'committed'
    `).get(accession)).toEqual({ count: 1 });
  });

  it("commits duplicate content as two distinct source occurrences", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const accession = `DUPLICATE-OCCURRENCES:${randomUUID()}`;
    const repeatedTable = "| Metric | Value |\n| Revenue | 100 |";
    mocks.embed.mockClear();
    mocks.upsert.mockClear();

    const stored = await storeDocument({
      text: `${repeatedTable}\n\n${repeatedTable}`,
      doc_id: accession,
      ticker: "AAPL",
      title: "AAPL duplicate table filing",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-07-14T12:00:00.000Z",
      acceptance_datetime: "2026-07-14T12:00:01.000Z"
    });

    expect(stored).toMatchObject({ attempted: 2, indexed: 2, documentComplete: true });
    // Exact embedding content is reused, but each physical occurrence still gets its own vector.
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const committedRecords = mocks.upsert.mock.calls
      .flatMap((call) => call[0].records)
      .filter((record) => record.metadata.accession === accession && record.metadata.ingest_state === "committed");
    expect(committedRecords).toHaveLength(2);
    expect(new Set(committedRecords.map((record) => record.id)).size).toBe(2);
    expect(new Set(committedRecords.map((record) => record.metadata.content_hash)).size).toBe(1);

    expect(getDb().prepare(`
      SELECT c.state, c.expected_vectors,
             COUNT(*) AS occurrences,
             COUNT(DISTINCT o.vector_id) AS vector_ids,
             COUNT(DISTINCT o.content_hash) AS content_hashes,
             COUNT(DISTINCT o.ordinal) AS ordinals
      FROM vector_ingest_commits c
      JOIN chunk_occurrences o ON o.commit_id = c.id AND o.receipt_state = 'committed'
      WHERE c.accession = ?
      GROUP BY c.id
    `).get(accession)).toEqual({
      state: "committed",
      expected_vectors: 2,
      occurrences: 2,
      vector_ids: 2,
      content_hashes: 1,
      ordinals: 2
    });
  });

  it("keeps a nonzero ingest-budget prefix non-queryable and writes no full-document receipts", async () => {
    const { getDb } = await import("../src/lib/db");
    const { filterMatchesForCommittedReceipts, storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    const accession = `SEC-INGEST-BUDGET:${randomUUID()}`;
    const nonce = randomUUID();
    db.exec("DELETE FROM rag_usage");
    mocks.embed.mockClear();
    mocks.upsert.mockClear();
    process.env.RAG_INGEST_BUDGET_ENABLED = "on";
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED = "off";

    const document = {
      text: `${nonce}-a ${nonce}-b ${nonce}-c ${nonce}-d ${nonce}-e ${nonce}-f ${nonce}-g ${nonce}-h`,
      doc_id: accession,
      ticker: "AAPL",
      title: "AAPL budget-limited 10-K",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-07-14T12:00:00.000Z"
    };
    const stored = await storeDocument(document, "local", { maxTokens: 36, overlapRatio: 0 });

    expect(stored).toMatchObject({
      attempted: 2,
      indexed: 1,
      budgetSkipped: 1,
      documentComplete: false
    });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const pendingRecord = mocks.upsert.mock.calls[0]![0].records[0];
    expect(pendingRecord.metadata.ingest_state).toBe("pending");
    expect(filterMatchesForCommittedReceipts([{ ...pendingRecord, score: 0.9 }])).toEqual([]);

    const commit = db.prepare(`
      SELECT id, state, expected_vectors FROM vector_ingest_commits WHERE accession = ?
    `).get(accession) as { id: string; state: string; expected_vectors: number };
    expect(commit).toMatchObject({ state: "aborted", expected_vectors: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(commit.id))
      .toEqual({ count: 0 });

    // Once capacity returns, the deterministic retry must materialize and commit the complete set.
    db.exec("DELETE FROM rag_usage");
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "2";
    const retried = await storeDocument(document, "local", { maxTokens: 36, overlapRatio: 0 });
    expect(retried).toMatchObject({ attempted: 2, indexed: 2, documentComplete: true });
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commit.id))
      .toEqual({ state: "committed" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM chunk_occurrences
      WHERE commit_id = ? AND receipt_state = 'committed'
    `).get(commit.id)).toEqual({ count: 2 });
  });

  it("keeps a nonzero write-unit-budget prefix non-queryable and retries the full set", async () => {
    const { getDb } = await import("../src/lib/db");
    const { filterMatchesForCommittedReceipts, storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    const accession = `SEC-WRITE-BUDGET:${randomUUID()}`;
    const nonce = randomUUID();
    db.exec("DELETE FROM rag_usage");
    mocks.embed.mockClear();
    mocks.upsert.mockClear();
    process.env.RAG_INGEST_BUDGET_ENABLED = "off";
    process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED = "on";
    // One managed record is ~6 estimated WUs with current metadata; doubled to ~12 for managed commits.
    // Two exceed a fuse of 15.
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "15";

    const document = {
      text: `${nonce}-a ${nonce}-b ${nonce}-c ${nonce}-d ${nonce}-e ${nonce}-f ${nonce}-g ${nonce}-h`,
      doc_id: accession,
      ticker: "MSFT",
      title: "MSFT budget-limited 10-Q",
      doc_type: "10-q",
      source: "sec-edgar",
      published_at: "2026-07-14T12:00:00.000Z"
    };
    const stored = await storeDocument(document, "local", { maxTokens: 36, overlapRatio: 0 });

    expect(stored).toMatchObject({
      attempted: 2,
      indexed: 1,
      writeUnitBudgetSkipped: 1,
      documentComplete: false
    });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const pendingRecord = mocks.upsert.mock.calls[0]![0].records[0];
    expect(pendingRecord.metadata.ingest_state).toBe("pending");
    expect(filterMatchesForCommittedReceipts([{ ...pendingRecord, score: 0.9 }])).toEqual([]);

    const commit = db.prepare(`
      SELECT id, state, expected_vectors FROM vector_ingest_commits WHERE accession = ?
    `).get(accession) as { id: string; state: string; expected_vectors: number };
    expect(commit).toMatchObject({ state: "aborted", expected_vectors: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(commit.id))
      .toEqual({ count: 0 });

    db.exec("DELETE FROM rag_usage");
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "100";
    const retried = await storeDocument(document, "local", { maxTokens: 36, overlapRatio: 0 });
    expect(retried).toMatchObject({ attempted: 2, indexed: 2, documentComplete: true });
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commit.id))
      .toEqual({ state: "committed" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM chunk_occurrences
      WHERE commit_id = ? AND receipt_state = 'committed'
    `).get(commit.id)).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT COUNT(DISTINCT vector_id) AS count FROM chunk_occurrences WHERE commit_id = ?
    `).get(commit.id)).toEqual({ count: 2 });
  });

  it("parks storeDocument before a commit when the rolling-24h write fuse is already spent", async () => {
    const { getDb } = await import("../src/lib/db");
    const { meterPineconeUpsert } = await import("../src/lib/rag-metering");
    const { storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    db.exec("DELETE FROM rag_usage");
    mocks.embed.mockClear();
    mocks.upsert.mockClear();
    process.env.RAG_INGEST_BUDGET_ENABLED = "off";
    process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED = "on";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "10";
    meterPineconeUpsert(1, "local", 10);

    const accession = `SEC-WU-SPENT:${randomUUID()}`;
    const stored = await storeDocument({
      text: `${randomUUID()} already-at-cap transcript body for fuse park`,
      doc_id: accession,
      ticker: "MSFT",
      title: "MSFT fuse-spent 10-Q",
      doc_type: "10-q",
      source: "sec-edgar",
      published_at: "2026-07-14T12:00:00.000Z"
    }, "local", { maxTokens: 36, overlapRatio: 0 });

    expect(stored).toMatchObject({
      indexed: 0,
      skipped: true,
      documentComplete: false
    });
    expect(stored.writeUnitBudgetSkipped).toBeGreaterThan(0);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_ingest_commits WHERE accession = ?").get(accession))
      .toEqual({ count: 0 });
  });

  it("requires the complete provider vector set before reconciliation can finalize a commit", async () => {
    const {
      beginVectorCommit,
      getDb,
      insertManagedChunkOccurrences,
      markVectorCommitReceiptsPersisted
    } = await import("../src/lib/db");
    const {
      buildOccurrenceVectorId,
      getCurrentVectorProviderAuthority,
      managedVectorLedgerAuthority,
      reconcileManagedVectorRecords,
      retrievalMetadataVersionFromMetadata
    } = await import("../src/lib/vector-db");
    const db = getDb();
    const commitId = "vcommit:test:complete-set";
    const source = "reconcile-complete-set-test";
    const accession = "FMP-EARNINGS-TRANSCRIPT:MSFT:2026:Q2:VERSION:test";
    const contentVersion = "content-version-test";
    const tenantScope = "shared:operator";
    const attemptToken = "attempt:test:complete-set";
    const acceptedAt = "2026-07-14T12:00:00.000Z";
    const providerAuthority = await getCurrentVectorProviderAuthority();
    if (!providerAuthority) throw new Error("Expected mocked Pinecone provider authority.");
    const ledgerAuthority = managedVectorLedgerAuthority();
    const retrievalMetadata = {
      source,
      accession,
      document_key: accession,
      symbol: "MSFT",
      ticker: ["MSFT"],
      doc_type: "earnings-transcript",
      timestamp: acceptedAt,
      acceptance_datetime: acceptedAt,
      document_title: "MSFT 2026 Q2 earnings call",
      as_of_epoch_ms: Date.parse(acceptedAt)
    };
    const retrievalMetadataVersion = retrievalMetadataVersionFromMetadata(retrievalMetadata);
    const vectorIdFor = (ordinal: number) => buildOccurrenceVectorId({
      ledgerAuthority,
      providerAuthority,
      tenantScope,
      source,
      accession,
      contentVersion: `${contentVersion}:metadata:${retrievalMetadataVersion}`,
      section: "body",
      ordinal,
      parserRevision: "fmp-transcript-v1",
      embedRevision: "v1"
    });
    beginVectorCommit({
      id: commitId,
      tenantScope,
      userId: "local",
      source,
      accession,
      documentKey: accession,
      contentVersion,
      retrievalMetadataVersion,
      parserRevision: "fmp-transcript-v1",
      embedRevision: "v1",
      expectedVectors: 2,
      providerAuthority,
      ledgerAuthority,
      vectorNamespace: "managed",
      attemptToken,
      leaseExpiresAt: "2026-07-14T13:00:00.000Z",
      now: "2026-07-14T12:00:00.000Z"
    });
    insertManagedChunkOccurrences([1, 2].map((ordinal) => ({
      vectorId: vectorIdFor(ordinal),
      contentHash: `hash-${ordinal}`,
      symbol: "MSFT",
      source,
      accession,
      section: "body",
      ordinal,
      acceptedAt,
      tenantScope,
      contentVersion,
      commitId,
      receiptState: "pending" as const,
      createdAt: "2026-07-14T12:00:00.000Z"
    })));
    markVectorCommitReceiptsPersisted(commitId, attemptToken, "2026-07-14T12:00:01.000Z");

    const metadata = (ordinal: number) => ({
      ...retrievalMetadata,
      source,
      accession,
      symbol: "MSFT",
      userId: "local",
      scope: "shared",
      vector_commit_id: commitId,
      document_key: accession,
      vector_attempt_token: attemptToken,
      content_version: contentVersion,
      content_hash: `hash-${ordinal}`,
      tenant_scope: tenantScope,
      ledger_authority: ledgerAuthority,
      provider_authority: providerAuthority,
      vector_namespace: "managed",
      section: "body",
      receipt_required: true,
      ingest_state: "pending",
      chunk_ordinal: ordinal,
      parser_revision: "fmp-transcript-v1",
      embed_revision: "v1",
      retrieval_metadata_version: retrievalMetadataVersion
    });
    mocks.listPaginated.mockResolvedValue({
      vectors: [{ id: vectorIdFor(1) }],
      pagination: {}
    });
    mocks.fetchRecords.mockResolvedValue({
      records: { [vectorIdFor(1)]: { id: vectorIdFor(1), metadata: metadata(1) } }
    });
    expect(await reconcileManagedVectorRecords({ source, dryRun: true })).toEqual({
      dryRun: true,
      promoteIds: [],
      deleteIds: [vectorIdFor(1)],
      invalidateCommitIds: [commitId],
      repairCommitIds: [],
      quarantineIds: [],
      promoted: 0,
      deleted: 0
    });
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commitId))
      .toEqual({ state: "receipts_persisted" });

    mocks.listPaginated.mockResolvedValue({
      vectors: [{ id: vectorIdFor(1) }, { id: vectorIdFor(2) }],
      pagination: {}
    });
    mocks.fetchRecords.mockResolvedValue({
      records: {
        [vectorIdFor(1)]: { id: vectorIdFor(1), metadata: metadata(1) },
        [vectorIdFor(2)]: { id: vectorIdFor(2), metadata: metadata(2) }
      }
    });
    const reconciled = await reconcileManagedVectorRecords({ source, dryRun: false });
    expect(reconciled).toMatchObject({ promoted: 2, deleted: 0 });
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commitId))
      .toEqual({ state: "committed" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM chunk_occurrences
      WHERE commit_id = ? AND receipt_state = 'committed'
    `).get(commitId)).toEqual({ count: 2 });
  });

  it("executes source completion only under the exact active commit proof and transaction", async () => {
    const {
      beginVectorCommit,
      getDb,
      insertManagedChunkOccurrences,
      markVectorCommitCommitted,
      markVectorCommitReceiptsPersisted,
      runWithActiveVectorCommitProof
    } = await import("../src/lib/db");
    const database = getDb();
    const source = `active-proof-${randomUUID()}`;
    const tenantScope = "shared:operator";
    const documentKey = `logical-${randomUUID()}`;
    const seed = (suffix: string, acceptedAt: string) => {
      const commitId = `vcommit:test:proof:${suffix}:${randomUUID()}`;
      const attemptToken = `attempt:test:proof:${suffix}:${randomUUID()}`;
      const vectorId = `occ:test:proof:${suffix}:${randomUUID()}`;
      expect(beginVectorCommit({
        id: commitId,
        tenantScope,
        userId: "local",
        source,
        accession: `${documentKey}:VERSION:${suffix}`,
        documentKey,
        contentVersion: `content:${suffix}`,
        retrievalMetadataVersion: `metadata:${suffix}`,
        parserRevision: "test-v1",
        embedRevision: "v1",
        expectedVectors: 1,
        providerAuthority: "provider:test:proof",
        attemptToken,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        now: acceptedAt
      })).toBe("started");
      insertManagedChunkOccurrences([{
        vectorId,
        contentHash: `hash:${suffix}`,
        symbol: "AAPL",
        source,
        accession: `${documentKey}:VERSION:${suffix}`,
        section: "body",
        ordinal: 1,
        acceptedAt,
        tenantScope,
        contentVersion: `content:${suffix}`,
        commitId,
        receiptState: "pending",
        createdAt: acceptedAt
      }]);
      markVectorCommitReceiptsPersisted(commitId, attemptToken, acceptedAt);
      markVectorCommitCommitted(commitId, attemptToken, acceptedAt);
      return { commitId, attemptToken };
    };
    const first = seed("first", "2026-01-01T00:00:00.000Z");
    const firstKey = `test:active-proof:first:${randomUUID()}`;
    runWithActiveVectorCommitProof(first, () => {
      database.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'ok', ?)")
        .run(firstKey, "2026-01-01T00:00:00.000Z");
    });
    expect(database.prepare("SELECT value FROM settings WHERE key = ?").get(firstKey)).toEqual({ value: "ok" });

    const current = seed("current", "2026-02-01T00:00:00.000Z");
    const staleKey = `test:active-proof:stale:${randomUUID()}`;
    expect(() => runWithActiveVectorCommitProof(first, () => {
      database.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'bad', ?)")
        .run(staleKey, "2026-02-01T00:00:00.000Z");
    })).toThrow("Vector commit proof is no longer active");
    expect(database.prepare("SELECT value FROM settings WHERE key = ?").get(staleKey)).toBeUndefined();

    const rollbackKey = `test:active-proof:rollback:${randomUUID()}`;
    expect(() => runWithActiveVectorCommitProof(current, () => {
      database.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'rollback', ?)")
        .run(rollbackKey, "2026-02-01T00:00:00.000Z");
      throw new Error("source-ledger-write-failed");
    })).toThrow("source-ledger-write-failed");
    expect(database.prepare("SELECT value FROM settings WHERE key = ?").get(rollbackKey)).toBeUndefined();
    expect(() => runWithActiveVectorCommitProof({
      commitId: current.commitId,
      attemptToken: "wrong-token"
    }, () => undefined)).toThrow("Vector commit proof is no longer active");
  });

  it("selects exactly one logical-document version for current and point-in-time retrieval", async () => {
    const {
      beginVectorCommit,
      committedManagedVectorReceipts,
      getDb,
      insertManagedChunkOccurrences,
      markVectorCommitCommitted,
      markVectorCommitReceiptsPersisted
    } = await import("../src/lib/db");
    const database = getDb();
    const documentKey = `FMP-EARNINGS-TRANSCRIPT:AAPL:2025:Q4:${randomUUID()}`;
    const tenantScope = "shared:operator";
    const source = "fmp-earnings-transcript";
    const firstAt = "2026-01-28T22:00:00.000Z";
    const correctedAt = "2026-02-03T15:30:00.000Z";

    const seedVersion = (input: {
      commitId: string;
      vectorId: string;
      accession: string;
      contentVersion: string;
      validFrom: string;
    }) => {
      const attemptToken = `attempt:${input.commitId}`;
      expect(beginVectorCommit({
        id: input.commitId,
        tenantScope,
        userId: "local",
        source,
        accession: input.accession,
        documentKey,
        contentVersion: input.contentVersion,
        retrievalMetadataVersion: `metadata:${input.contentVersion}`,
        parserRevision: "fmp-transcript-v1",
        embedRevision: "v1",
        expectedVectors: 1,
        attemptToken,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        now: input.validFrom
      })).toBe("started");
      insertManagedChunkOccurrences([{
        vectorId: input.vectorId,
        contentHash: `hash:${input.contentVersion}`,
        symbol: "AAPL",
        source,
        accession: input.accession,
        section: "body",
        ordinal: 1,
        acceptedAt: input.validFrom,
        tenantScope,
        contentVersion: input.contentVersion,
        commitId: input.commitId,
        receiptState: "pending",
        createdAt: input.validFrom
      }]);
      markVectorCommitReceiptsPersisted(input.commitId, attemptToken, input.validFrom);
      markVectorCommitCommitted(input.commitId, attemptToken, input.validFrom);
    };

    const first = {
      commitId: `vcommit:test:first:${randomUUID()}`,
      vectorId: `occ:test:first:${randomUUID()}`,
      accession: `${documentKey}:VERSION:first`,
      contentVersion: "content:first",
      validFrom: firstAt
    };
    const corrected = {
      commitId: `vcommit:test:corrected:${randomUUID()}`,
      vectorId: `occ:test:corrected:${randomUUID()}`,
      accession: `${documentKey}:VERSION:corrected`,
      contentVersion: "content:corrected",
      validFrom: correctedAt
    };
    seedVersion(first);
    seedVersion(corrected);

    expect([...committedManagedVectorReceipts([first.vectorId, corrected.vectorId]).keys()])
      .toEqual([corrected.vectorId]);
    expect([...committedManagedVectorReceipts(
      [first.vectorId, corrected.vectorId],
      "2026-02-01T00:00:00.000Z"
    ).keys()]).toEqual([first.vectorId]);
    expect([...committedManagedVectorReceipts(
      [first.vectorId, corrected.vectorId],
      correctedAt
    ).keys()]).toEqual([corrected.vectorId]);
    expect(database.prepare(`
      SELECT commit_id, valid_from, valid_to
      FROM vector_document_versions
      WHERE tenant_scope = ? AND source = ? AND document_key = ?
      ORDER BY valid_from, commit_id
    `).all(tenantScope, source, documentKey)).toEqual([
      { commit_id: first.commitId, valid_from: firstAt, valid_to: correctedAt },
      { commit_id: corrected.commitId, valid_from: correctedAt, valid_to: null }
    ]);
    expect(database.prepare(`
      SELECT commit_id FROM vector_document_heads
      WHERE tenant_scope = ? AND source = ? AND accession = ?
    `).get(tenantScope, source, documentKey)).toEqual({ commit_id: corrected.commitId });
  });

  it("chunks a maximum six-tier receipt lookup below SQLite bind limits", async () => {
    const {
      beginVectorCommit,
      committedManagedVectorReceipts,
      insertManagedChunkOccurrences,
      markVectorCommitCommitted,
      markVectorCommitReceiptsPersisted
    } = await import("../src/lib/db");
    const suffix = randomUUID();
    const commitId = `vcommit:test:large-receipt-lookup:${suffix}`;
    const vectorId = `occ:test:large-receipt-lookup:${suffix}`;
    const documentKey = `logical-document:large-receipt-lookup:${suffix}`;
    const source = `large-receipt-lookup-${suffix}`;
    const attemptToken = `attempt:${suffix}`;
    const acceptedAt = "2026-02-04T12:00:00.000Z";

    expect(beginVectorCommit({
      id: commitId,
      tenantScope: "shared:operator",
      userId: "local",
      source,
      accession: documentKey,
      documentKey,
      contentVersion: `content:${suffix}`,
      retrievalMetadataVersion: `metadata:${suffix}`,
      parserRevision: "test-v1",
      embedRevision: "test-v1",
      expectedVectors: 1,
      attemptToken,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      now: acceptedAt
    })).toBe("started");
    insertManagedChunkOccurrences([{
      vectorId,
      contentHash: `hash:${suffix}`,
      symbol: "AAPL",
      source,
      accession: documentKey,
      section: "body",
      ordinal: 1,
      acceptedAt,
      tenantScope: "shared:operator",
      contentVersion: `content:${suffix}`,
      commitId,
      receiptState: "pending",
      createdAt: acceptedAt
    }]);
    markVectorCommitReceiptsPersisted(commitId, attemptToken, acceptedAt);
    markVectorCommitCommitted(commitId, attemptToken, acceptedAt);

    // Retrieval may combine six independent provider tiers of 10,000 candidates. Keep the
    // committed match last so every batch is exercised; the old one-statement lookup exceeded
    // SQLite's host-parameter ceiling and silently degraded managed retrieval to no matches.
    const candidateIds = Array.from(
      { length: 59_999 },
      (_, index) => `missing:large-receipt-lookup:${suffix}:${index}`
    );
    candidateIds.push(vectorId);

    expect([...committedManagedVectorReceipts(candidateIds).keys()]).toEqual([vectorId]);
  });

  it("activates a historically accepted reconciliation correction strictly after the current head", async () => {
    const {
      beginVectorCommit,
      committedManagedVectorReceipts,
      getDb,
      insertManagedChunkOccurrences,
      markVectorCommitCommitted,
      markVectorCommitReceiptsPersisted,
      reconcileVectorCommitCommitted
    } = await import("../src/lib/db");
    const database = getDb();
    const tenantScope = "shared:operator";
    const source = `monotonic-reconcile-${randomUUID()}`;
    const documentKey = `logical-document-${randomUUID()}`;
    const currentAt = "2026-02-03T15:30:00.000Z";
    const activationAt = "2026-02-03T15:30:00.001Z";
    const current = {
      commitId: `vcommit:test:current:${randomUUID()}`,
      vectorId: `occ:test:current:${randomUUID()}`,
      accession: `${documentKey}:VERSION:current`,
      contentVersion: "content:current",
      attemptToken: `attempt:current:${randomUUID()}`
    };
    const currentInput = {
      id: current.commitId,
      tenantScope,
      userId: "local",
      source,
      accession: current.accession,
      documentKey,
      contentVersion: current.contentVersion,
      retrievalMetadataVersion: "metadata:current",
      parserRevision: "test-parser-v1",
      embedRevision: "v1",
      expectedVectors: 1,
      providerAuthority: "pinecone:shared-authority",
      attemptToken: current.attemptToken,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      now: currentAt
    };
    expect(beginVectorCommit(currentInput)).toBe("started");
    insertManagedChunkOccurrences([{
      vectorId: current.vectorId,
      contentHash: "hash:current",
      symbol: "AAPL",
      source,
      accession: current.accession,
      section: "body",
      ordinal: 1,
      acceptedAt: currentAt,
      tenantScope,
      contentVersion: current.contentVersion,
      commitId: current.commitId,
      receiptState: "pending",
      createdAt: currentAt
    }]);
    markVectorCommitReceiptsPersisted(current.commitId, current.attemptToken, currentAt);
    markVectorCommitCommitted(current.commitId, current.attemptToken, currentAt);
    expect(() => beginVectorCommit({
      ...currentInput,
      attemptToken: `attempt:authority-mismatch:${randomUUID()}`,
      providerAuthority: "pinecone:other-authority"
    })).toThrow("Vector commit identity mismatch");

    const corrective = {
      commitId: `vcommit:test:historical-correction:${randomUUID()}`,
      vectorId: `occ:test:historical-correction:${randomUUID()}`,
      accession: `${documentKey}:VERSION:historical-correction`,
      contentVersion: "content:historical-correction",
      attemptToken: `attempt:historical-correction:${randomUUID()}`
    };
    const receiptAt = "2026-01-01T00:00:00.000Z";
    expect(beginVectorCommit({
      id: corrective.commitId,
      tenantScope,
      userId: "local",
      source,
      accession: corrective.accession,
      documentKey,
      contentVersion: corrective.contentVersion,
      retrievalMetadataVersion: "metadata:historical-correction",
      parserRevision: "test-parser-v1",
      embedRevision: "v1",
      expectedVectors: 1,
      attemptToken: corrective.attemptToken,
      leaseExpiresAt: "2026-01-02T00:00:00.000Z",
      now: receiptAt
    })).toBe("started");
    insertManagedChunkOccurrences([{
      vectorId: corrective.vectorId,
      contentHash: "hash:historical-correction",
      symbol: "AAPL",
      source,
      accession: corrective.accession,
      section: "body",
      ordinal: 1,
      acceptedAt: receiptAt,
      tenantScope,
      contentVersion: corrective.contentVersion,
      commitId: corrective.commitId,
      receiptState: "pending",
      createdAt: receiptAt
    }]);
    markVectorCommitReceiptsPersisted(
      corrective.commitId,
      corrective.attemptToken,
      "2026-01-01T00:00:01.000Z"
    );
    reconcileVectorCommitCommitted(corrective.commitId, corrective.attemptToken, currentAt);

    expect([...committedManagedVectorReceipts([current.vectorId, corrective.vectorId]).keys()])
      .toEqual([corrective.vectorId]);
    const atCurrent = committedManagedVectorReceipts(
      [current.vectorId, corrective.vectorId],
      currentAt
    );
    expect([...atCurrent.keys()]).toEqual([current.vectorId]);
    expect(atCurrent.get(current.vectorId)?.providerAuthority).toBe("pinecone:shared-authority");
    expect([...committedManagedVectorReceipts(
      [current.vectorId, corrective.vectorId],
      activationAt
    ).keys()]).toEqual([corrective.vectorId]);
    expect(database.prepare(`
      SELECT commit_id, valid_from, valid_to
      FROM vector_document_versions
      WHERE tenant_scope = ? AND source = ? AND document_key = ?
      ORDER BY valid_from, commit_id
    `).all(tenantScope, source, documentKey)).toEqual([
      { commit_id: current.commitId, valid_from: currentAt, valid_to: activationAt },
      { commit_id: corrective.commitId, valid_from: activationAt, valid_to: null }
    ]);
    expect(database.prepare(`
      SELECT commit_id FROM vector_document_heads
      WHERE tenant_scope = ? AND source = ? AND accession = ?
    `).get(tenantScope, source, documentKey)).toEqual({ commit_id: corrective.commitId });
  });

  it("repairs damaged history and never invalidates an active head from provider-list omission", async () => {
    const {
      beginVectorCommit,
      getDb,
      insertManagedChunkOccurrences,
      markVectorCommitCommitted,
      markVectorCommitReceiptsPersisted
    } = await import("../src/lib/db");
    const {
      buildOccurrenceVectorId,
      getCurrentVectorProviderAuthority,
      managedVectorLedgerAuthority,
      reconcileManagedVectorRecords,
      retrievalMetadataVersionFromMetadata
    } = await import("../src/lib/vector-db");
    const database = getDb();
    const tenantScope = "shared:operator";
    const source = `historical-repair-test-${randomUUID()}`;
    const documentKey = `logical-document-${randomUUID()}`;
    const providerAuthority = await getCurrentVectorProviderAuthority();
    if (!providerAuthority) throw new Error("Expected mocked Pinecone provider authority.");
    const ledgerAuthority = managedVectorLedgerAuthority();

    const seedVersion = (suffix: string, validFrom: string) => {
      const commitId = `vcommit:test:${suffix}:${randomUUID()}`;
      const accession = `${documentKey}:VERSION:${suffix}`;
      const contentVersion = `content:${suffix}`;
      const attemptToken = `attempt:${suffix}:${randomUUID()}`;
      const retrievalMetadata = {
        source,
        accession,
        document_key: documentKey,
        symbol: "AAPL",
        ticker: ["AAPL"],
        doc_type: "test-document",
        timestamp: validFrom,
        acceptance_datetime: validFrom,
        document_title: `AAPL test document ${suffix}`,
        as_of_epoch_ms: Date.parse(validFrom)
      };
      const retrievalMetadataVersion = retrievalMetadataVersionFromMetadata(retrievalMetadata);
      const vectorId = buildOccurrenceVectorId({
        ledgerAuthority,
        providerAuthority,
        tenantScope,
        source,
        accession,
        contentVersion: `${contentVersion}:metadata:${retrievalMetadataVersion}`,
        section: "body",
        ordinal: 1,
        parserRevision: "test-parser-v1",
        embedRevision: "v1"
      });
      expect(beginVectorCommit({
        id: commitId,
        tenantScope,
        userId: "local",
        source,
        accession,
        documentKey,
        contentVersion,
        retrievalMetadataVersion,
        parserRevision: "test-parser-v1",
        embedRevision: "v1",
        expectedVectors: 1,
        providerAuthority,
        ledgerAuthority,
        vectorNamespace: "managed",
        attemptToken,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        now: validFrom
      })).toBe("started");
      insertManagedChunkOccurrences([{
        vectorId,
        contentHash: `hash:${suffix}`,
        symbol: "AAPL",
        source,
        accession,
        section: "body",
        ordinal: 1,
        acceptedAt: validFrom,
        tenantScope,
        contentVersion,
        commitId,
        receiptState: "pending",
        createdAt: validFrom
      }]);
      markVectorCommitReceiptsPersisted(commitId, attemptToken, validFrom);
      markVectorCommitCommitted(commitId, attemptToken, validFrom);
      return {
        commitId,
        vectorId,
        metadata: {
          ...retrievalMetadata,
          userId: "local",
          vector_commit_id: commitId,
          vector_attempt_token: attemptToken,
          content_version: contentVersion,
          content_hash: `hash:${suffix}`,
          tenant_scope: tenantScope,
          ledger_authority: ledgerAuthority,
          provider_authority: providerAuthority,
          vector_namespace: "managed",
          section: "body",
          receipt_required: true,
          ingest_state: "committed",
          chunk_ordinal: 1,
          parser_revision: "test-parser-v1",
          embed_revision: "v1",
          retrieval_metadata_version: retrievalMetadataVersion
        }
      };
    };

    const historical = seedVersion("historical", "2026-01-01T00:00:00.000Z");
    const current = seedVersion("current", "2026-02-01T00:00:00.000Z");
    mocks.listPaginated.mockResolvedValue({
      vectors: [{ id: historical.vectorId }, { id: current.vectorId }],
      pagination: {}
    });
    mocks.fetchRecords.mockResolvedValue({
      records: {
        [historical.vectorId]: {
          id: historical.vectorId,
          metadata: { ...historical.metadata, content_hash: "corrupt-provider-hash" }
        },
        [current.vectorId]: { id: current.vectorId, metadata: current.metadata }
      }
    });
    const deleteCallsBefore = mocks.deleteMany.mock.calls.length;

    const first = await reconcileManagedVectorRecords({ source, dryRun: false });
    expect(first).toMatchObject({
      repairCommitIds: [historical.commitId],
      invalidateCommitIds: [],
      deleteIds: [],
      deleted: 0
    });
    const observation = database.prepare(`
      SELECT last_observed_at FROM vector_reconcile_observations WHERE commit_id = ?
    `).get(historical.commitId) as { last_observed_at: string };
    database.prepare(`
      UPDATE vector_reconcile_observations SET first_observed_at = ? WHERE commit_id = ?
    `).run(new Date(Date.parse(observation.last_observed_at) - 10 * 60_000).toISOString(), historical.commitId);

    const confirmed = await reconcileManagedVectorRecords({ source, dryRun: false });
    expect(confirmed).toMatchObject({
      repairCommitIds: [historical.commitId],
      invalidateCommitIds: [],
      deleteIds: [],
      deleted: 0
    });
    expect(mocks.deleteMany).toHaveBeenCalledTimes(deleteCallsBefore);
    expect(database.prepare(`
      SELECT state FROM vector_ingest_commits WHERE id = ?
    `).get(historical.commitId)).toEqual({ state: "committed" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM vector_document_versions WHERE commit_id = ?
    `).get(historical.commitId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT commit_id FROM vector_document_heads
      WHERE tenant_scope = ? AND source = ? AND accession = ?
    `).get(tenantScope, source, documentKey)).toEqual({ commit_id: current.commitId });

    // Pinecone list inventory is eventually consistent. Even after the same active-head omission
    // survives the confirmation grace, it is a repair signal—not proof that the durable head or
    // its local receipts can be invalidated.
    mocks.listPaginated.mockResolvedValue({
      vectors: [{ id: historical.vectorId }],
      pagination: {}
    });
    mocks.fetchRecords.mockResolvedValue({
      records: {
        [historical.vectorId]: {
          id: historical.vectorId,
          metadata: { ...historical.metadata, content_hash: "corrupt-provider-hash" }
        }
      }
    });
    const omittedOnce = await reconcileManagedVectorRecords({ source, dryRun: false });
    expect(omittedOnce).toMatchObject({
      invalidateCommitIds: [],
      deleteIds: [],
      deleted: 0
    });
    const currentObservation = database.prepare(`
      SELECT last_observed_at FROM vector_reconcile_observations WHERE commit_id = ?
    `).get(current.commitId) as { last_observed_at: string };
    database.prepare(`
      UPDATE vector_reconcile_observations SET first_observed_at = ? WHERE commit_id = ?
    `).run(
      new Date(Date.parse(currentObservation.last_observed_at) - 10 * 60_000).toISOString(),
      current.commitId
    );

    const omittedConfirmed = await reconcileManagedVectorRecords({ source, dryRun: false });
    expect(omittedConfirmed).toMatchObject({
      invalidateCommitIds: [],
      deleteIds: [],
      deleted: 0
    });
    expect(omittedConfirmed.repairCommitIds).toEqual(expect.arrayContaining([
      historical.commitId,
      current.commitId
    ]));
    expect(mocks.deleteMany).toHaveBeenCalledTimes(deleteCallsBefore);
    expect(database.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(current.commitId))
      .toEqual({ state: "committed" });
    expect(database.prepare(`
      SELECT commit_id FROM vector_document_heads
      WHERE tenant_scope = ? AND source = ? AND accession = ?
    `).get(tenantScope, source, documentKey)).toEqual({ commit_id: current.commitId });
  });

  it("records each physical Voyage retry as its own durable provider attempt", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    db.exec("DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;");
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "1";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    mocks.embed
      .mockRejectedValueOnce(Object.assign(new Error("429 synthetic retry"), { status: 429 }))
      .mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });

    const stored = await storeDocument({
      text: `Unique retry corpus ${randomUUID()} with enough context for one document chunk.`,
      doc_id: `FMP-EARNINGS-TRANSCRIPT:NVDA:2026:Q2:VERSION:${randomUUID()}`,
      ticker: "NVDA",
      title: "NVDA earnings call 2026 Q2",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-07-14T12:00:00.000Z"
    });

    expect(stored.documentComplete).toBe(true);
    expect(db.prepare(`
      SELECT status FROM provider_dispatch_attempts
      WHERE provider = 'voyage' AND operation = 'embed document'
      ORDER BY rowid
    `).all()).toEqual([{ status: "failed" }, { status: "succeeded" }]);
    expect(db.prepare(`
      SELECT outcome FROM provider_usage_outbox
      WHERE provider = 'voyage' AND operation = 'embed document'
      ORDER BY rowid
    `).all()).toEqual([{ outcome: "failed" }, { outcome: "succeeded" }]);
    delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
    delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
  });

  it("forces tenant documents private and holds the deletion fence through provider writes", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument, vectorTenantScope } = await import("../src/lib/vector-db");
    const db = getDb();
    const userId = `tenant-${randomUUID()}`;
    let activeClaimsAtUpsert = 0;
    let pendingMetadata: Record<string, unknown> | undefined;
    mocks.upsert.mockImplementationOnce(async (input) => {
      activeClaimsAtUpsert = (db.prepare(`
        SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'account_user_operation:%'
      `).get() as { count: number }).count;
      pendingMetadata = input.records[0]?.metadata;
    });

    const stored = await storeDocument({
      text: `Private tenant transcript ${randomUUID()} with durable provider-write fencing.`,
      doc_id: `FMP-EARNINGS-TRANSCRIPT:MSFT:2026:Q2:VERSION:${randomUUID()}`,
      ticker: "MSFT",
      title: "MSFT earnings call 2026 Q2",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-07-14T12:00:00.000Z"
    }, userId, { scope: "shared" });

    expect(stored.documentComplete).toBe(true);
    expect(activeClaimsAtUpsert).toBe(1);
    expect(pendingMetadata).toMatchObject({
      userId,
      scope: "private",
      tenant_scope: vectorTenantScope(userId, "private")
    });
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'account_user_operation:%'
    `).get() as { count: number }).count).toBe(0);
  });

  it("uses exact tenant/content/parser identity for stable collision-safe occurrence IDs", async () => {
    const { buildOccurrenceVectorId, vectorTenantScope } = await import("../src/lib/vector-db");
    const base = {
      source: "fmp-earnings-transcript",
      accession: "FMP-EARNINGS-TRANSCRIPT:AAPL:2026:Q1",
      contentVersion: "sha256-v1",
      section: "body",
      ordinal: 1,
      parserRevision: "fmp-transcript-v1",
      embedRevision: "v1",
      providerAuthority: "pinecone:test-authority"
    };
    const scopeA = vectorTenantScope("user/a");
    const scopeB = vectorTenantScope("user?a");
    expect(scopeA).not.toBe(scopeB);
    const first = buildOccurrenceVectorId({ ...base, tenantScope: scopeA });
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA })).toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeB })).not.toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA, contentVersion: "sha256-v2" }))
      .not.toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA, parserRevision: "fmp-transcript-v2" }))
      .not.toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA, providerAuthority: "pinecone:other-authority" }))
      .not.toBe(first);
  });
});

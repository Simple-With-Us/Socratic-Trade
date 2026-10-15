/**
 * Item 5 (2026-07-01 RAG workstream): align the per-chunk char cap with the token chunker.
 *
 * Before this change, storeContexts unconditionally trimmed every document to
 * DEFAULT_CONTEXT_MAX_CHARS (2400 chars) — including chunks storeDocument already produced via
 * chunkDocument's 480-TOKEN budget, which chunkDocument deliberately keeps atomic (e.g. a table).
 * A near-max-size token-bounded chunk plus its context_header could exceed 2400 chars and get a
 * SECOND, silent truncation with a "[truncated for vector memory]" suffix appended mid-content.
 *
 * storeDocument now computes a cap aligned with the actual chunker token budget
 * (maxTokens * CHARS_PER_TOKEN_CEILING + a header allowance) and passes it to storeContexts via the
 * new StoreContextsOptions.maxChars — so an already-atomic, already-token-bounded chunk round-trips
 * without truncation. Direct storeContexts callers (8-K summaries, disclosures) are unaffected:
 * they never pass maxChars, so they keep the exact default (contextMaxChars(), 2400).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const namespacedIndex = { upsert, query };
  const namespace = vi.fn(() => namespacedIndex);
  const index = vi.fn(() => ({ ...namespacedIndex, namespace }));
  const transaction = vi.fn((callback: () => void) => () => callback());
  const prepare = vi.fn<(sql?: unknown) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => { changes: number };
  }>((sql?: unknown) => ({
    get: vi.fn<(...args: unknown[]) => unknown>(() => (
      typeof sql === "string" && sql.includes("fmp_transcript_rights_gate")
        ? { generation: 1, status: "active" }
        : typeof sql === "string" && sql.includes("SELECT value FROM settings WHERE key")
          ? { value: JSON.stringify("ledger:v1:test-managed-vector-ledger") }
          : { ok: 1 }
    )),
    all: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
    run: vi.fn<(...args: unknown[]) => { changes: number }>(() => ({ changes: 1 }))
  }));
  const committedManagedVectorReceipts = vi.fn((ids: string[]) => {
    const records = upsert.mock.calls.flatMap((call) => call[0].records) as Array<{
      id: string;
      metadata: Record<string, unknown>;
    }>;
    return new Map(ids.flatMap((id) => {
      const record = [...records].reverse().find((candidate) => (
        candidate.id === id && candidate.metadata.ingest_state === "committed"
      ));
      return record ? [[id, {
        commitId: record.metadata.vector_commit_id,
        contentVersion: record.metadata.content_version,
        tenantScope: record.metadata.tenant_scope,
        contentHash: record.metadata.content_hash,
        symbol: record.metadata.symbol,
        source: record.metadata.source,
        accession: record.metadata.accession,
        documentKey: record.metadata.document_key,
        section: record.metadata.section,
        ordinal: record.metadata.chunk_ordinal,
        parserRevision: record.metadata.parser_revision,
        embedRevision: record.metadata.embed_revision,
        retrievalMetadataVersion: record.metadata.retrieval_metadata_version,
        attemptToken: record.metadata.vector_attempt_token,
        providerAuthority: record.metadata.provider_authority,
        ledgerAuthority: record.metadata.ledger_authority,
        vectorNamespace: record.metadata.vector_namespace
      }]] : [];
    }));
  });
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    describeIndex: vi.fn(),
    createIndex: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn(),
    filterNewDocumentChunks: vi.fn(),
    insertDocumentChunks: vi.fn(),
    insertChunkOccurrences: vi.fn(),
    beginVectorCommit: vi.fn(),
    abortVectorCommit: vi.fn(),
    renewVectorCommitLease: vi.fn(),
    markVectorCommitReceiptsPersisted: vi.fn(),
    markVectorCommitCommitted: vi.fn(),
    committedManagedVectorReceipts,
    reserveProviderDispatch: vi.fn(() => ({ admitted: true, attemptId: "test-dispatch" })),
    markProviderDispatchStarted: vi.fn(),
    settleProviderDispatch: vi.fn(),
    getDb: vi.fn(() => ({ transaction, prepare })),
    transaction,
    prepare,
    setInternalSetting: vi.fn(),
    audit: vi.fn(),
    namespace
  };
});

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
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: mocks.setInternalSetting,
  filterNewDocumentChunks: mocks.filterNewDocumentChunks,
  insertDocumentChunks: mocks.insertDocumentChunks,
  insertChunkOccurrences: mocks.insertChunkOccurrences,
  insertManagedChunkOccurrences: mocks.insertChunkOccurrences,
  beginVectorCommit: mocks.beginVectorCommit,
  abortVectorCommit: mocks.abortVectorCommit,
  renewVectorCommitLease: mocks.renewVectorCommitLease,
  markVectorCommitReceiptsPersisted: mocks.markVectorCommitReceiptsPersisted,
  markVectorCommitCommitted: mocks.markVectorCommitCommitted,
  committedManagedVectorReceipts: mocks.committedManagedVectorReceipts,
  reserveProviderDispatch: mocks.reserveProviderDispatch,
  markProviderDispatchStarted: mocks.markProviderDispatchStarted,
  settleProviderDispatch: mocks.settleProviderDispatch,
  getDb: mocks.getDb
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  process.env.VECTOR_ENABLE_RERANK = "off";
  process.env.HYBRID_RETRIEVAL = "off";
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;
  delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
  delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({
    host: "socratic-trade-test.svc.test.pinecone.io",
    metric: "cosine"
  });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  mocks.filterNewDocumentChunks.mockImplementation((hashes: Array<{ content_hash: string }>) => hashes);
});

// A single markdown table kept ATOMIC by chunkDocument (tables are never split), long enough in
// CHARS to exceed the OLD fixed 2400-char cap, while staying tiny in TOKENS (chunkDocument's
// whitespace-based counter) because table cells are packed pipe-delimited with no internal
// whitespace — exactly the "long words/table padding" case CHARS_PER_TOKEN_CEILING exists for.
function buildLargeAtomicTableDoc(): string {
  const rows: string[] = ["|Metric|Q1|Q2|Q3|Q4|Q5|Q6|Q7|"];
  for (let i = 0; i < 45; i++) {
    rows.push(`|LineItem${i}|${i * 1111111}|${i * 2222222}|${i * 3333333}|${i * 4444444}|${i * 5555555}|${i * 6666666}|${i * 7777777}|`);
  }
  return rows.join("\n");
}

describe("storeDocument: per-chunk char cap aligned with the token chunker (item 5)", () => {
  it("uses the active OpenRouter embedding authority in production when Voyage is unavailable", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalEmbeddingProvider = process.env.RAG_EMBED_PROVIDER;
    const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
    const originalVoyageApiKey = process.env.VOYAGE_API_KEY;
    vi.stubEnv("NODE_ENV", "production");
    process.env.RAG_EMBED_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "openrouter-test";
    delete process.env.VOYAGE_API_KEY;
    mocks.resolveApiKey.mockImplementation((service: string) => {
      if (service === "pinecone") return process.env.PINECONE_API_KEY;
      if (service === "openrouter") return process.env.OPENROUTER_API_KEY;
      return undefined;
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1024 }, (_, index) => index / 1024) }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    try {
      const { storeDocument } = await import("../src/lib/vector-db");
      const stored = await storeDocument({
        text: "OpenRouter managed-ingestion regression with material filing context.",
        doc_id: "OPENROUTER-MANAGED-INGESTION-REGRESSION",
        ticker: "AAPL",
        title: "AAPL managed filing",
        doc_type: "10-q",
        source: "sec-edgar",
        published_at: "2026-07-21T12:00:00.000Z"
      });

      expect(stored).toMatchObject({ indexed: 1, documentComplete: true });
      expect(mocks.embed).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/embeddings",
        expect.objectContaining({ method: "POST" })
      );
      // Managed documents write pending records, persist relational receipts, then mark the
      // provider records committed. Reaching both calls proves this did not return unconfigured.
      expect(mocks.upsert).toHaveBeenCalledTimes(2);
      expect(mocks.upsert.mock.calls[0]![0].records[0].metadata.ingest_state).toBe("pending");
      expect(mocks.upsert.mock.calls[1]![0].records[0].metadata.ingest_state).toBe("committed");
    } finally {
      const restoreEnv = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restoreEnv("NODE_ENV", originalNodeEnv);
      restoreEnv("RAG_EMBED_PROVIDER", originalEmbeddingProvider);
      restoreEnv("OPENROUTER_API_KEY", originalOpenRouterApiKey);
      restoreEnv("VOYAGE_API_KEY", originalVoyageApiKey);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("does not truncate a large atomic (table) chunk that fits the chunker's token budget", async () => {
    const tableText = buildLargeAtomicTableDoc();
    expect(tableText.length).toBeGreaterThan(2400); // would have hit the OLD fixed cap

    const { storeDocument } = await import("../src/lib/vector-db");
    await storeDocument({
      text: tableText,
      ticker: "AAPL",
      title: "AAPL 10-K (2026-06-20)",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-06-20"
    });

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    expect(embeddedTexts.length).toBeGreaterThan(0);
    for (const text of embeddedTexts) {
      expect(text).not.toContain("[truncated for vector memory]");
    }
  });

  it("still applies the default 2400-char cap for a DIRECT storeContexts caller (8-K summaries) — unaffected by the storeDocument alignment", async () => {
    const longSummary = "AAPL 8-K catalyst filing. ".repeat(150); // well over 2400 chars, not chunked
    expect(longSummary.length).toBeGreaterThan(2400);

    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: longSummary, metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);

    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    expect(embeddedTexts[0]).toContain("[truncated for vector memory]");
  });

  // C5 expert-review correction: is_table chunks are EXEMPT from trimming entirely (not just given
  // a bigger cap) — a table so large it would exceed even the token-aligned cap must still round-trip
  // whole, because truncating mid-row corrupts numeric data. Verified directly via storeContexts with
  // metadata.is_table=true (the same metadata storeDocument attaches for table chunks).
  it("never trims an is_table=true document, even one far larger than the token-aligned cap", async () => {
    // Build a table intentionally larger than storeDocument's own aligned cap (480*8+512=4352 chars)
    // to prove the exemption is unconditional, not just "a bigger number".
    const rows: string[] = ["|Metric|Q1|Q2|Q3|Q4|Q5|Q6|Q7|Q8|Q9|Q10|"];
    for (let i = 0; i < 200; i++) {
      rows.push(`|LineItem${i}|${i * 1111111}|${i * 2222222}|${i * 3333333}|${i * 4444444}|${i * 5555555}|${i * 6666666}|${i * 7777777}|${i * 8888888}|${i * 9999999}|${i}|`);
    }
    const hugeTable = rows.join("\n");
    expect(hugeTable.length).toBeGreaterThan(4352);

    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: hugeTable, metadata: { symbol: "AAPL", source: "sec-edgar", timestamp: "2026-06-20", is_table: true } }
    ], "local", { maxChars: 2400 }); // even with an explicit small maxChars, is_table must win

    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    expect(embeddedTexts[0]).not.toContain("[truncated for vector memory]");
    // The full table content (last row) must be present untouched.
    expect(embeddedTexts[0]).toContain("|LineItem199|");
  });

  it("content_hash (computed pre-trim by chunkDocument) stays consistent with the stored text for a table chunk", async () => {
    const { hashContent } = await import("../src/lib/rag/chunk");
    const tableText = buildLargeAtomicTableDoc();

    const { storeDocument } = await import("../src/lib/vector-db");
    await storeDocument({
      text: tableText,
      ticker: "AAPL",
      title: "AAPL 10-K (2026-06-20)",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-06-20"
    });

    // The required completion transaction receives the pre-trim content hash from chunkDocument.
    const hashesPassed = mocks.insertDocumentChunks.mock.calls[0][0] as Array<{ content_hash: string }>;
    expect(hashesPassed.length).toBeGreaterThan(0);
    // Since the chunk is a table (is_table=true), it is never trimmed downstream — so the hash of
    // the RAW table text (as chunkDocument produced it, pre-header) still matches what's embedded
    // modulo the context_header prefix. Confirm no truncation marker snuck in either way.
    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    for (const text of embeddedTexts) {
      expect(text).not.toContain("[truncated for vector memory]");
    }
    expect(hashesPassed[0]!.content_hash).toBe(hashContent(tableText));
  });

  it("keeps content_hash content-derived across source-document occurrences", async () => {
    const { hashContent } = await import("../src/lib/rag/chunk");
    const { storeDocument } = await import("../src/lib/vector-db");
    const text = "Operator: Welcome to the quarterly earnings call. Forward-looking statements apply.";

    await storeDocument({
      text,
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20"
    });
    await storeDocument({
      text,
      doc_id: "AAPL:2026:Q2",
      ticker: "AAPL",
      title: "AAPL Q2 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-07-20"
    });

    const first = mocks.insertDocumentChunks.mock.calls[0][0][0].content_hash;
    const second = mocks.insertDocumentChunks.mock.calls[1][0][0].content_hash;
    expect(first).toBe(hashContent(text));
    expect(second).toBe(hashContent(text));
    // Exact raw content is embedded once, but both occurrences are materialized as real vectors.
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const records = mocks.upsert.mock.calls
      .flatMap((call) => call[0].records)
      .filter((record) => record.metadata.ingest_state === "committed");
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    expect(records.map((record) => record.metadata.accession)).toEqual(["AAPL:2026:Q1", "AAPL:2026:Q2"]);
  });

  it("materializes and retrieves identical content as distinct ticker/accession/PIT occurrences", async () => {
    const storedRecords: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];
    let failFirstMsftWrite = true;
    mocks.upsert.mockImplementation(async ({ records }: { records: typeof storedRecords }) => {
      const symbol = records[0]?.metadata.symbol;
      if (symbol === "MSFT" && failFirstMsftWrite) {
        failFirstMsftWrite = false;
        throw new Error("synthetic Pinecone write failure");
      }
      for (const record of records) {
        const existing = storedRecords.findIndex((candidate) => candidate.id === record.id);
        if (existing >= 0) storedRecords[existing] = record;
        else storedRecords.push(record);
      }
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = "Operator: Welcome. Management discussed durable demand and margin expansion.";
    const { retrieveContextDetailed, storeDocument } = await import("../src/lib/vector-db");

    const aapl = await storeDocument({
      text,
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20T20:00:00.000Z",
      acceptance_datetime: "2026-04-21T01:00:00.000Z"
    });
    const failedMsft = await storeDocument({
      text,
      doc_id: "MSFT:2026:Q2",
      ticker: "MSFT",
      title: "MSFT Q2 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-07-20T20:00:00.000Z",
      acceptance_datetime: "2026-07-21T01:00:00.000Z"
    });
    expect(aapl.documentComplete).toBe(true);
    expect(failedMsft).toMatchObject({ documentComplete: false });
    expect(failedMsft.error).toContain("synthetic Pinecone write failure");
    expect(storedRecords).toHaveLength(1);
    expect(mocks.insertChunkOccurrences).toHaveBeenCalledTimes(1);
    expect(mocks.insertChunkOccurrences.mock.calls.flatMap((call) => call[0]))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ accession: "MSFT:2026:Q2" })]));

    const msft = await storeDocument({
      text,
      doc_id: "MSFT:2026:Q2",
      ticker: "MSFT",
      title: "MSFT Q2 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-07-20T20:00:00.000Z",
      acceptance_datetime: "2026-07-21T01:00:00.000Z"
    });
    expect(msft.documentComplete).toBe(true);
    expect(storedRecords).toHaveLength(2);
    expect(mocks.insertChunkOccurrences).toHaveBeenCalledTimes(2);
    expect(new Set(storedRecords.map((record) => record.id)).size).toBe(2);
    expect(storedRecords.map((record) => record.metadata.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(storedRecords.map((record) => record.metadata.accession).sort()).toEqual(["AAPL:2026:Q1", "MSFT:2026:Q2"]);
    expect(mocks.embed.mock.calls.filter((call) => call[0].inputType === "document")).toHaveLength(1);

    const aaplRecord = storedRecords.find((record) => record.metadata.symbol === "AAPL")!;
    const msftRecord = storedRecords.find((record) => record.metadata.symbol === "MSFT")!;
    // Return the matching provider record for every queried namespace. Retrieval must validate the
    // managed receipt, enforce PIT, and deduplicate it independent of how many corpus namespaces
    // the implementation consults; a brittle sequence of one-shot mock responses would couple this
    // regression to the current query fan-out count.
    mocks.query.mockImplementation(async (request: { filter?: Record<string, unknown> }) => {
      const filter = JSON.stringify(request.filter ?? {});
      if (filter.includes("AAPL")) return { matches: [{ ...aaplRecord, score: 0.95 }] };
      if (filter.includes("MSFT")) return { matches: [{ ...msftRecord, score: 0.95 }] };
      return { matches: [] };
    });

    const aaplRetrieved = await retrieveContextDetailed("earnings outlook", "AAPL", 3, "local", {
      docType: ["earnings-transcript"],
      asOf: "2026-05-01T00:00:00.000Z"
    });
    const msftBeforePIT = await retrieveContextDetailed("earnings outlook", "MSFT", 3, "local", {
      docType: ["earnings-transcript"],
      asOf: "2026-07-20T23:59:59.000Z"
    });
    const msftRetrieved = await retrieveContextDetailed("earnings outlook", "MSFT", 3, "local", {
      docType: ["earnings-transcript"],
      asOf: "2026-07-22T00:00:00.000Z"
    });

    expect(aaplRetrieved).toHaveLength(1);
    expect(aaplRetrieved[0]).toMatchObject({ id: aaplRecord.id, as_of: "2026-04-21T01:00:00.000Z" });
    expect(aaplRetrieved[0]!.text).toContain("Filing: AAPL Q1 earnings call");
    expect(aaplRetrieved[0]!.text).toContain(text);
    expect(aaplRetrieved[0]!.metadata).toMatchObject({ symbol: "AAPL", accession: "AAPL:2026:Q1" });
    expect(msftBeforePIT).toEqual([]);
    expect(msftRetrieved).toHaveLength(1);
    expect(msftRetrieved[0]).toMatchObject({ id: msftRecord.id, as_of: "2026-07-21T01:00:00.000Z" });
    expect(msftRetrieved[0]!.text).toContain("Filing: MSFT Q2 earnings call");
    expect(msftRetrieved[0]!.text).toContain(text);
    expect(msftRetrieved[0]!.metadata).toMatchObject({ symbol: "MSFT", accession: "MSFT:2026:Q2" });
    quiet.mockRestore();
  });

  it.each([
    ["document_chunks", "insertDocumentChunks"],
    ["chunk_occurrences", "insertChunkOccurrences"]
  ] as const)("keeps source completion false when the %s receipt write fails", async (_label, failingMock) => {
    mocks[failingMock].mockImplementationOnce(() => {
      throw new Error(`synthetic ${failingMock} failure`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storeDocument } = await import("../src/lib/vector-db");

    const result = await storeDocument({
      text: "Management discussed revenue growth and customer demand.",
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20",
      acceptance_datetime: "2026-04-21"
    });

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalled();
    expect(result).toMatchObject({
      indexed: 1,
      error: "document-receipt-write-failed",
      documentComplete: false
    });
    warn.mockRestore();
  });

  it("keeps source completion false when an idempotent receipt insert has no matching row", async () => {
    mocks.prepare.mockImplementation((sql?: unknown) => ({
      get: vi.fn<(...args: unknown[]) => unknown>(() =>
        String(sql).includes("FROM document_chunks")
          ? undefined
          : String(sql).includes("fmp_transcript_rights_gate")
            ? { generation: 1, status: "active" }
            : { ok: 1 }
      ),
      all: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
      run: vi.fn<(...args: unknown[]) => { changes: number }>(() => ({ changes: 1 }))
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storeDocument } = await import("../src/lib/vector-db");

    const result = await storeDocument({
      text: "Management discussed revenue growth and customer demand.",
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20",
      acceptance_datetime: "2026-04-21"
    });

    expect(result).toMatchObject({
      indexed: 1,
      error: "document-receipt-write-failed",
      documentComplete: false
    });
    warn.mockRestore();
  });

  it("forwards the lease abort signal to Voyage and stops before Pinecone when ownership is lost", async () => {
    let ownsLease = true;
    const controller = new AbortController();
    mocks.embed.mockImplementationOnce(async () => {
      ownsLease = false;
      controller.abort(new Error("lease heartbeat lost ownership"));
      return { data: [{ embedding: [0.1, 0.2] }] };
    });

    const { storeDocument } = await import("../src/lib/vector-db");
    await expect(storeDocument({
      text: "Management: Revenue grew 12 percent year over year.",
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20"
    }, "local", {
      leaseGuard: {
        assertOwnership: () => {
          if (!ownsLease) throw new Error("lease heartbeat lost ownership");
        },
        signal: controller.signal
      }
    })).rejects.toThrow("lease heartbeat lost ownership");

    expect(mocks.embed.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.insertDocumentChunks).not.toHaveBeenCalled();
    expect(mocks.insertChunkOccurrences).not.toHaveBeenCalled();
    expect(mocks.setInternalSetting).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("treats a real SDK abort rejection as lease loss without failure ledgers", async () => {
    const controller = new AbortController();
    mocks.embed.mockImplementationOnce(async () => {
      const reason = new Error("lease aborted inside Voyage SDK");
      controller.abort(reason);
      throw reason;
    });

    const { storeDocument } = await import("../src/lib/vector-db");
    await expect(storeDocument({
      text: "Management discussed revenue growth and customer demand.",
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20"
    }, "local", {
      leaseGuard: {
        assertOwnership: () => undefined,
        signal: controller.signal
      }
    })).rejects.toThrow("lease aborted inside Voyage SDK");

    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.insertDocumentChunks).not.toHaveBeenCalled();
    expect(mocks.insertChunkOccurrences).not.toHaveBeenCalled();
    expect(mocks.setInternalSetting).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("treats an aborted Voyage retry backoff as lease loss without failure ledgers", async () => {
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "1";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "10000";
    const controller = new AbortController();
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    mocks.embed.mockImplementationOnce(async () => {
      setTimeout(() => controller.abort(new Error("lease aborted during Voyage backoff")), 0);
      throw Object.assign(new Error("429 rate limit"), { status: 429 });
    });

    const { storeDocument } = await import("../src/lib/vector-db");
    await expect(storeDocument({
      text: "Management discussed revenue growth and customer demand.",
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20"
    }, "local", {
      leaseGuard: {
        assertOwnership: () => undefined,
        signal: controller.signal
      }
    })).rejects.toThrow("lease aborted during Voyage backoff");
    random.mockRestore();

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.insertDocumentChunks).not.toHaveBeenCalled();
    expect(mocks.insertChunkOccurrences).not.toHaveBeenCalled();
    expect(mocks.setInternalSetting).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects an invalid embedding batch atomically without prefix receipts", async () => {
    mocks.embed.mockImplementationOnce(async (request: { input: string[] }) => ({
      data: request.input.map((_text, index) => ({
        embedding: index === 1 ? [0.1, Number.NaN] : [0.1, 0.2]
      }))
    }));

    const { storeDocument } = await import("../src/lib/vector-db");
    const result = await storeDocument({
      text: [
        "Management discussed revenue growth and customer demand.",
        "Analysts asked about gross margin and operating expenses.",
        "Management answered with updated capital allocation priorities."
      ].join("\n\n"),
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20"
    }, "local", { maxTokens: 7 });

    expect(result.rejectedInvalidEmbeddings).toBe(1);
    expect(result.indexed).toBe(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.insertDocumentChunks).not.toHaveBeenCalled();
    expect(mocks.insertChunkOccurrences).not.toHaveBeenCalled();
  });

  it("keeps every document receipt retryable when Voyage returns a short batch", async () => {
    mocks.embed.mockImplementationOnce(async (request: { input: string[] }) => ({
      data: request.input.slice(0, -1).map(() => ({ embedding: [0.1, 0.2] }))
    }));

    const { storeDocument } = await import("../src/lib/vector-db");
    const result = await storeDocument({
      text: [
        "Management discussed revenue growth and customer demand.",
        "Analysts asked about gross margin and operating expenses.",
        "Management answered with updated capital allocation priorities."
      ].join("\n\n"),
      doc_id: "AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL Q1 earnings call",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20"
    }, "local", { maxTokens: 7 });

    expect(result.indexed).toBe(0);
    expect(result.rejectedInvalidEmbeddings).toBeGreaterThan(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.insertDocumentChunks).not.toHaveBeenCalled();
    expect(mocks.insertChunkOccurrences).not.toHaveBeenCalled();
  });
});

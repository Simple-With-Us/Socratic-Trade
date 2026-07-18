// ADVERSARIAL VERIFICATION TEST — originally written to EXHIBIT the purge-gate hole in
// corpus-reembed.ts (2026-07-18 review, MUST-FIX 1): a SYMBOL-SCOPED re-embed run used to stamp
// its docType "completed" under the current embedding-space revision, which satisfied
// purgeLegacyEmbeddingSpace's per-docType completion gate and let the purge delete EVERY
// legacy-space vector for that source — including symbols the scoped run never touched, whose
// ONLY embedding was the legacy one.
//
// This file now PROVES THE FIX (assertions inverted from the original exploit script):
//   Phase 3 — after a symbol-scoped bge run, the purge REFUSES (scoped runs persist no
//     completion stamp at all), no provider delete is issued, and the victim symbol's voyage
//     receipts stay intact.
//   Phase 4 — after a genuine FULL-corpus bge run, the purge proceeds, deletes exactly the
//     legacy-space vectors, and retires their local ledger receipts (commits aborted,
//     occurrences removed) so drift reports stay clean and a voyage flip-back can never
//     reusedCommitted against deleted vectors.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-corpus-reembed-adv-${randomUUID()}.db`)}`;
process.env.ENCRYPTION_KEY = "0".repeat(64);

const mocks = vi.hoisted(() => {
  const upsert = vi.fn(async (_input: {
    records: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>;
  }) => undefined);
  const deleteMany = vi.fn(async (_input: { ids: string[] }) => undefined);
  const namespacedIndex = {
    upsert,
    query: vi.fn(async () => ({ matches: [] })),
    listPaginated: vi.fn(async () => ({ vectors: [], pagination: undefined })),
    fetch: vi.fn(async () => ({ records: {} })),
    deleteMany
  };
  const index = vi.fn(() => ({
    ...namespacedIndex,
    namespace: vi.fn(() => namespacedIndex)
  }));
  return {
    upsert,
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

beforeEach(async () => {
  const { resetOperationLeaseForTest } = await import("../src/lib/operation-lease");
  resetOperationLeaseForTest();
});

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
}): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  db.prepare(`
    INSERT INTO document_chunks_fts (content_hash, symbol, source, accession, text)
    VALUES (?, ?, 'sec-edgar', ?, ?)
  `).run(row.contentHash, row.symbol, row.accession, row.text);
  db.prepare(`
    INSERT OR IGNORE INTO sec_filings (accession, cik, ticker, form, filed_at, accepted_at, status, chunk_count, created_at, updated_at)
    VALUES (?, '0000320193', ?, '10-K', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'complete', 1, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
  `).run(row.accession, row.symbol);
}

describe("corpus-reembed adversarial: symbol-scoped runs can never unlock the legacy-space purge", () => {
  it("purge refuses after a scoped run, then succeeds — and retires receipts — only after a FULL run", async () => {
    const { resetCorpusReembedStateForTest, runCorpusReembedForTest, purgeLegacyEmbeddingSpace } =
      await import("../src/lib/rag/corpus-reembed");
    const { getDb } = await import("../src/lib/db");
    resetCorpusReembedStateForTest();

    // Two filings in the local corpus: SAFE (will be re-embedded into bge) and VICT (won't be).
    await insertSecFilingChunk({
      contentHash: "hash-adv-safe-1",
      symbol: "SAFE",
      accession: "0000320193-26-100001",
      text: "SAFE Corp filing text: durable revenue growth commentary, adversarial fixture."
    });
    await insertSecFilingChunk({
      contentHash: "hash-adv-vict-1",
      symbol: "VICT",
      accession: "0000320193-26-100002",
      text: "VICT Corp filing text: margin compression risk discussion, adversarial fixture."
    });

    // Phase 1 — simulate the historical VOYAGE-era corpus: full run for BOTH symbols while
    // voyage-finance-2 is active. Produces committed embed_revision 'v1' receipts for both.
    await deactivateBgeM3();
    const voyageRun = await runCorpusReembedForTest({ docTypes: ["sec-filings"] });
    expect(voyageRun.acquired).toBe(true);
    expect(voyageRun.result!.embedRevision).toBe("v1");
    const voyageSec = voyageRun.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(voyageSec.embedded).toBe(2);
    expect(voyageSec.completed).toBe(true);

    // Phase 2 — flip to bge-m3 and run a SYMBOL-SCOPED re-embed covering only SAFE (the original
    // exploit script, verbatim: reset progress first so the scoped run is the only signal).
    resetCorpusReembedStateForTest();
    await activateBgeM3();
    const scoped = await runCorpusReembedForTest({ docTypes: ["sec-filings"], symbols: ["SAFE"] });
    expect(scoped.acquired).toBe(true);
    expect(scoped.result!.embedRevision).toBe("v1-baai-bge-m3");
    const scopedSec = scoped.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(scopedSec.candidatesSeen).toBe(1); // only SAFE was processed
    expect(scopedSec.completed).toBe(true); // run-level: the scoped scan reached its end...

    // ...but scoped runs persist NO completion stamp (they are stateless targeted top-ups), so
    // VICT still has no bge-space commit and the purge gate has nothing to trust.
    const victBgeCommits = getDb().prepare(`
      SELECT COUNT(*) AS n FROM vector_ingest_commits
      WHERE source = 'sec-edgar' AND embed_revision = 'v1-baai-bge-m3' AND accession LIKE '%hash-adv-vict-1%'
    `).get() as { n: number };
    expect(victBgeCommits.n).toBe(0);

    // VICT's voyage vector id — the only retrievable copy of its content.
    const victVoyageRows = getDb().prepare(`
      SELECT o.vector_id AS vector_id
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      WHERE c.source = 'sec-edgar' AND c.embed_revision = 'v1' AND c.accession LIKE '%hash-adv-vict-1%'
        AND c.state = 'committed'
    `).all() as Array<{ vector_id: string }>;
    expect(victVoyageRows.length).toBeGreaterThan(0);
    const victVoyageIds = new Set(victVoyageRows.map((r) => r.vector_id));

    // Phase 3 — THE FIX: the purge must REFUSE. No completion stamp exists for the current
    // space (the scoped run persisted nothing), no provider delete may be issued, and VICT's
    // voyage receipts must remain fully intact.
    mocks.deleteMany.mockClear();
    const refusedPurge = await purgeLegacyEmbeddingSpace({ docTypes: ["sec-filings"], confirm: "purge-voyage-vectors" });
    expect(refusedPurge.acquired).toBe(true);
    expect(refusedPurge.result!.ok).toBe(false);
    expect(refusedPurge.result!.refused).toMatch(/has not completed a FULL corpus-reembed run/);
    expect(refusedPurge.result!.purged).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    const victReceiptsAfterRefusal = getDb().prepare(`
      SELECT COUNT(*) AS n
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      WHERE c.source = 'sec-edgar' AND c.embed_revision = 'v1' AND c.state = 'committed'
    `).get() as { n: number };
    expect(victReceiptsAfterRefusal.n).toBe(2); // SAFE + VICT voyage receipts untouched

    // Phase 4 — the legitimate path: a FULL bge run covers every symbol, and only then does the
    // purge proceed. It must delete exactly the legacy (voyage) vectors — including VICT's, whose
    // content is now safely re-embedded in bge — and retire their ledger receipts.
    const fullRun = await runCorpusReembedForTest({ docTypes: ["sec-filings"] });
    const fullSec = fullRun.result!.docTypes.find((d) => d.docType === "sec-filings")!;
    expect(fullSec.completed).toBe(true);
    expect(fullSec.failed).toBe(0);
    // SAFE was already committed in bge by the scoped run (reused); VICT embeds now.
    expect(fullSec.embedded + fullSec.reusedInSpace).toBe(2);

    mocks.deleteMany.mockClear();
    const purge = await purgeLegacyEmbeddingSpace({ docTypes: ["sec-filings"], confirm: "purge-voyage-vectors" });
    expect(purge.acquired).toBe(true);
    expect(purge.result!.ok).toBe(true);
    expect(purge.result!.purged).toBe(2); // both voyage vectors, nothing else

    const deletedIds = new Set(
      mocks.deleteMany.mock.calls.flatMap((call) => (call[0] as { ids: string[] }).ids)
    );
    for (const id of victVoyageIds) {
      expect(deletedIds.has(id)).toBe(true);
    }

    // Ledger receipts of the purged commits are retired in the same operation: commits aborted,
    // occurrence receipts removed — so drift reports stay clean and a voyage flip-back re-embeds
    // instead of reusedCommitted-ing against vectors that no longer exist.
    const voyageCommitStates = getDb().prepare(`
      SELECT state, COUNT(*) AS n FROM vector_ingest_commits
      WHERE source = 'sec-edgar' AND embed_revision = 'v1'
      GROUP BY state
    `).all() as Array<{ state: string; n: number }>;
    expect(voyageCommitStates).toEqual([{ state: "aborted", n: 2 }]);
    const voyageOccurrences = getDb().prepare(`
      SELECT COUNT(*) AS n
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      WHERE c.source = 'sec-edgar' AND c.embed_revision = 'v1'
    `).get() as { n: number };
    expect(voyageOccurrences.n).toBe(0);

    // The current-space (bge) receipts are untouched.
    const bgeCommits = getDb().prepare(`
      SELECT COUNT(*) AS n FROM vector_ingest_commits
      WHERE source = 'sec-edgar' AND embed_revision = 'v1-baai-bge-m3' AND state = 'committed'
    `).get() as { n: number };
    expect(bgeCommits.n).toBe(2);
  }, 120_000);
});

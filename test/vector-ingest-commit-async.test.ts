/**
 * Vector-ingest commit lane chunking (2026-11-25 stall follow-up to ST#5487).
 *
 * The managed-commit receipt writes used to run as single whole-document SQLite
 * transactions: insertManagedChunkOccurrences inserted every occurrence in one
 * transaction, and finalizeVectorCommit flipped every receipt_state in one
 * transaction. On large filings those transactions held the serving event loop
 * for 17-19s (production stall profiles, 2026-11-25) and starved /api/live.
 *
 * The async twins chunk the same work into bounded slice transactions with
 * event-loop yields between them. These tests pin the contract: identical end
 * state (committed, retrievable receipts), yields actually happen between
 * slices, the cardinality guard still rejects an incomplete receipt set before
 * flipping anything, and a retry after that rejection converges.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = join(tmpdir(), `vector-ingest-commit-async-${randomUUID()}.db`);

afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

type DbModule = typeof import("../src/lib/db");
let dbModule: DbModule;

beforeAll(async () => {
  dbModule = await import("../src/lib/db");
  dbModule.getDb();
}, 60_000);

function makeOccurrences(commitId: string, count: number, startOrdinal = 0) {
  return Array.from({ length: count }, (_, i) => ({
    vectorId: `${commitId}-vec-${startOrdinal + i}`,
    contentHash: `${commitId}-hash-${startOrdinal + i}`,
    symbol: "AAPL",
    source: "sec-edgar",
    accession: "0000320193-25-000001",
    section: "body",
    ordinal: startOrdinal + i,
    acceptedAt: "2026-11-20T13:00:00.000Z",
    tenantScope: "shared:operator",
    contentVersion: "content-v1",
    commitId,
    receiptState: "pending" as const,
    createdAt: "2026-11-25T00:00:00.000Z"
  }));
}

function beginCommit(commitId: string, attemptToken: string, expectedVectors: number) {
  return dbModule.beginVectorCommit({
    id: commitId,
    tenantScope: "shared:operator",
    userId: "local",
    source: "sec-edgar",
    accession: "0000320193-25-000001",
    documentKey: "0000320193-25-000001",
    contentVersion: "content-v1",
    retrievalMetadataVersion: "meta-v1",
    parserRevision: "v1",
    embedRevision: "v4",
    expectedVectors,
    attemptToken,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z"
  });
}

describe("vector-ingest commit lane async chunking", () => {
  it("persists and finalizes a multi-chunk commit with yields, ending fully retrievable", async () => {
    const commitId = `commit-async-${randomUUID()}`;
    const attemptToken = `attempt-${randomUUID()}`;
    const total = 600; // > 2x the 250-row production chunk
    expect(beginCommit(commitId, attemptToken, total)).toBe("started");

    const insertYields = vi.fn(async () => {});
    await dbModule.insertManagedChunkOccurrencesAsync(makeOccurrences(commitId, total), {
      chunkSize: 100,
      yieldBetweenChunks: insertYields
    });
    expect(insertYields).toHaveBeenCalledTimes(5); // 6 slices, yields between them
    const pending = dbModule.getDb().prepare(
      "SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ? AND receipt_state = 'pending'"
    ).get(commitId) as { count: number };
    expect(pending.count).toBe(total);

    dbModule.markVectorCommitReceiptsPersisted(commitId, attemptToken);

    const finalizeYields = vi.fn(async () => {});
    await dbModule.markVectorCommitCommittedAsync(commitId, attemptToken, new Date().toISOString(), {
      chunkSize: 100,
      yieldBetweenChunks: finalizeYields
    });
    expect(finalizeYields).toHaveBeenCalledTimes(5);

    const commit = dbModule.getDb().prepare(
      "SELECT state FROM vector_ingest_commits WHERE id = ?"
    ).get(commitId) as { state: string };
    expect(commit.state).toBe("committed");
    const committed = dbModule.getDb().prepare(
      "SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ? AND receipt_state = 'committed'"
    ).get(commitId) as { count: number };
    expect(committed.count).toBe(total);

    const receipts = dbModule.committedManagedVectorReceipts(
      makeOccurrences(commitId, total).map((o) => o.vectorId)
    );
    expect(receipts.size).toBe(total);
  });

  it("rejects an incomplete receipt set before flipping anything, then converges on retry", async () => {
    const commitId = `commit-async-partial-${randomUUID()}`;
    const attemptToken = `attempt-${randomUUID()}`;
    expect(beginCommit(commitId, attemptToken, 5)).toBe("started");
    await dbModule.insertManagedChunkOccurrencesAsync(makeOccurrences(commitId, 4));
    dbModule.markVectorCommitReceiptsPersisted(commitId, attemptToken);

    await expect(
      dbModule.markVectorCommitCommittedAsync(commitId, attemptToken)
    ).rejects.toThrow("Vector commit receipt cardinality mismatch.");
    const afterReject = dbModule.getDb().prepare(
      "SELECT state FROM vector_ingest_commits WHERE id = ?"
    ).get(commitId) as { state: string };
    expect(afterReject.state).toBe("receipts_persisted");
    const stillPending = dbModule.getDb().prepare(
      "SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ? AND receipt_state = 'pending'"
    ).get(commitId) as { count: number };
    expect(stillPending.count).toBe(4);

    await dbModule.insertManagedChunkOccurrencesAsync(makeOccurrences(commitId, 1, 4));
    await dbModule.markVectorCommitCommittedAsync(commitId, attemptToken);
    const commit = dbModule.getDb().prepare(
      "SELECT state FROM vector_ingest_commits WHERE id = ?"
    ).get(commitId) as { state: string };
    expect(commit.state).toBe("committed");
  });

  it("sync insert path stays chunked and idempotent", async () => {
    const commitId = `commit-sync-${randomUUID()}`;
    const attemptToken = `attempt-${randomUUID()}`;
    expect(beginCommit(commitId, attemptToken, 300)).toBe("started");
    dbModule.insertManagedChunkOccurrences(makeOccurrences(commitId, 300));
    dbModule.insertManagedChunkOccurrences(makeOccurrences(commitId, 300)); // replay: INSERT OR IGNORE
    const rows = dbModule.getDb().prepare(
      "SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?"
    ).get(commitId) as { count: number };
    expect(rows.count).toBe(300);
  });
});

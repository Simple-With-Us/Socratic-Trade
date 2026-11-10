import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyVersionedMigrations, getDb } from "../src/lib/db";
import { FTS_MIRROR_MAX_CHUNKS_PER_TICK } from "../src/lib/rag/fts-mirror-bound";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-persist-local-${randomUUID()}.db`)}`;
  applyVersionedMigrations(getDb());
});

afterEach(() => {
  getDb().exec(`
    DELETE FROM document_chunks_fts_index;
    DELETE FROM document_chunks_fts;
    DELETE FROM ingested_accessions;
  `);
  vi.restoreAllMocks();
});

describe("persistLocalComplete bounded FTS mirror", () => {
  it("yields and gates when strategy work is in flight", async () => {
    const { persistLocalComplete } = await import("../src/lib/rag/persist-local-complete");
    const { insertStrategyRun, finishStrategyRun } = await import("../src/lib/db-execution");
    const yieldSpy = vi.spyOn(await import("../src/lib/slow-sync-guard"), "yieldEventLoop");

    const chunkCount = FTS_MIRROR_MAX_CHUNKS_PER_TICK + 4;
    const chunks = Array.from({ length: chunkCount }, (_, i) => ({
      content_hash: `hash-yield-${i.toString().padStart(3, "0")}`,
      text: `chunk body ${i} with enough text to index`
    }));

    const runId = randomUUID();
    const userId = `persist-local-${randomUUID()}`;
    insertStrategyRun(runId, userId);

    const result = await persistLocalComplete({
      ticker: "MSFT",
      accession: "0000789019-26-000001",
      docType: "10-K",
      chunks,
      recordLedger: true
    });

    finishStrategyRun(runId, "failed", "test release", userId);

    expect(result.abortedByStrategy).toBe(true);
    expect(result.ftsMirrorComplete).toBe(false);
    expect(result.ftsMirrorOffset).toBe(0);
    expect(yieldSpy).not.toHaveBeenCalled();
    const ledger = getDb()
      .prepare("SELECT 1 FROM ingested_accessions WHERE accession = ?")
      .get("0000789019-26-000001");
    expect(ledger).toBeUndefined();
  });

  it("mirrors all chunks with yields when no strategy work is in flight", async () => {
    const { persistLocalComplete } = await import("../src/lib/rag/persist-local-complete");
    const yieldSpy = vi.spyOn(await import("../src/lib/slow-sync-guard"), "yieldEventLoop");

    const chunkCount = FTS_MIRROR_MAX_CHUNKS_PER_TICK + 3;
    const chunks = Array.from({ length: chunkCount }, (_, i) => ({
      content_hash: `hash-complete-${i.toString().padStart(3, "0")}`,
      text: `complete chunk ${i} with enough text to index`
    }));

    const result = await persistLocalComplete({
      ticker: "MSFT",
      accession: "0000789019-26-000002",
      docType: "10-K",
      chunks,
      recordLedger: true
    });

    expect(result.abortedByStrategy).toBe(false);
    expect(result.ftsMirrorComplete).toBe(true);
    expect(result.ftsMirrorOffset).toBe(chunkCount);
    expect(yieldSpy.mock.calls.length).toBeGreaterThan(0);
    const indexCount = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts_index
         WHERE symbol = 'MSFT' AND source = 'sec-edgar' AND accession = ?`
      )
      .get("0000789019-26-000002") as { n: number };
    expect(indexCount.n).toBe(chunkCount);
    const ledger = getDb()
      .prepare("SELECT chunk_count FROM ingested_accessions WHERE accession = ?")
      .get("0000789019-26-000002") as { chunk_count: number };
    expect(ledger.chunk_count).toBe(chunkCount);
  });
});

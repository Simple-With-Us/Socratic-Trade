import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-fts-mirror-${randomUUID()}.db`)}`;
});

const KEY = { symbol: "HSY", source: "sec-edgar", accession: "0001628280-26-028682:1:hsy-20260329.htm" };

/**
 * Production 2026-09-09: the bounded FTS mirror resumed from `countDocumentChunkFts()` and used
 * that COUNT as a POSITIONAL offset into the chunk array.  `document_chunks_fts_index` is keyed
 * `(content_hash, symbol, source, accession)`, so two byte-identical chunks in one filing collapse
 * onto ONE row.  From the first duplicate the count trails the position forever, so the same slice
 * was re-mirrored on every ingest tick — 198 slices / 1,317,546ms of pinned event loop on 09-08 —
 * and `complete` never became true, so the filing was never marked ingested.
 */
function rowsWithDuplicateTail() {
  const rows: Array<{ contentHash: string; symbol: string; source: string; accession: string; text: string }> = [];
  for (let i = 0; i < 6; i++) {
    rows.push({ contentHash: `hash-unique-${i}`, ...KEY, text: `unique body ${i}` });
  }
  for (let i = 0; i < 6; i++) {
    rows.push({ contentHash: `hash-unique-${i}`, ...KEY, text: `unique body ${i}` });
  }
  rows.push({ contentHash: "hash-unique-tail", ...KEY, text: "tail body" });
  return rows;
}

describe("FTS mirror resume offset — convergence", () => {
  it("count-based resume trails the position once a document repeats chunk text", async () => {
    const { insertDocumentChunkFtsBatch, countDocumentChunkFts, ftsMirrorResumeOffset } = await import("../src/lib/db");
    const rows = rowsWithDuplicateTail();

    await insertDocumentChunkFtsBatch(rows.slice(0, 12));

    expect(countDocumentChunkFts(KEY)).toBe(6);
    expect(ftsMirrorResumeOffset(rows, KEY)).toBe(12);
  });

  it("mirrorFtsChunksBounded converges to complete on a document with duplicate chunks", async () => {
    const { mirrorFtsChunksBounded } = await import("../src/lib/rag/mirror-fts-bounded");
    const rows = rowsWithDuplicateTail();

    let last = -1;
    let guard = 0;
    let result = await mirrorFtsChunksBounded(rows, { resumeKey: KEY, gateStrategyWork: false });
    while (!result.complete && guard++ < 50) {
      expect(result.offset).toBeGreaterThan(last);
      last = result.offset;
      result = await mirrorFtsChunksBounded(rows, { resumeKey: KEY, gateStrategyWork: false });
    }
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(rows.length);
    expect(guard).toBeLessThan(50);
  });

  it("re-running a fully mirrored document is a no-op that reports complete", async () => {
    const { mirrorFtsChunksBounded } = await import("../src/lib/rag/mirror-fts-bounded");
    const rows = rowsWithDuplicateTail();
    const again = await mirrorFtsChunksBounded(rows, { resumeKey: KEY, gateStrategyWork: false });
    expect(again.complete).toBe(true);
    expect(again.offset).toBe(rows.length);
  });
});

/**
 * Codex review on PR #3202 (P2): a side-index key alone is not proof the content is mirrored.
 * `document_chunks_fts_index` can hold a STALE key — FTS5 reuses the max rowid after a DELETE,
 * so an unpaired bulk wipe of `document_chunks_fts` leaves keys pointing at nothing (or at a
 * later filing's chunk).  The reviewer's exact case: rows [A, A, B] with only a stale key for A
 * would skip BOTH A entries, write only B, and report complete — ledgering the filing with its
 * A content absent.  That is the same failure class this change exists to remove.
 */
describe("FTS mirror resume offset — stale side-index keys", () => {
  const STALE_KEY = { symbol: "STALE", source: "sec-edgar", accession: "stale:1:doc.htm" };

  it("does not treat a stale index key as mirrored content ([A, A, B] case)", async () => {
    const { insertDocumentChunkFtsBatch, ftsMirrorResumeOffset, getDb } = await import("../src/lib/db");
    const rows = [
      { contentHash: "stale-A", ...STALE_KEY, text: "alpha body" },
      { contentHash: "stale-A", ...STALE_KEY, text: "alpha body" },
      { contentHash: "stale-B", ...STALE_KEY, text: "bravo body" }
    ];

    // Mirror A only, then simulate the unpaired FTS wipe: drop the live FTS row but LEAVE the
    // side-index key behind, exactly the state ftsRowidStillOwnsOccurrence was written for.
    await insertDocumentChunkFtsBatch([rows[0]!]);
    expect(ftsMirrorResumeOffset(rows, STALE_KEY)).toBe(2);

    const db = getDb();
    const rowid = (
      db
        .prepare("SELECT fts_rowid FROM document_chunks_fts_index WHERE content_hash = ? AND accession = ?")
        .get("stale-A", STALE_KEY.accession) as { fts_rowid: number }
    ).fts_rowid;
    db.prepare("DELETE FROM document_chunks_fts WHERE rowid = ?").run(rowid);

    // The key still exists but owns nothing live.  The resume must NOT skip A.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts_index WHERE content_hash = ? AND accession = ?")
        .get("stale-A", STALE_KEY.accession)
    ).toEqual({ n: 1 });
    expect(ftsMirrorResumeOffset(rows, STALE_KEY)).toBe(0);
  });

  it("re-mirrors the orphaned content and only then reports complete", async () => {
    const { mirrorFtsChunksBounded } = await import("../src/lib/rag/mirror-fts-bounded");
    const { getDb } = await import("../src/lib/db");
    const rows = [
      { contentHash: "stale-A", ...STALE_KEY, text: "alpha body" },
      { contentHash: "stale-A", ...STALE_KEY, text: "alpha body" },
      { contentHash: "stale-B", ...STALE_KEY, text: "bravo body" }
    ];
    const result = await mirrorFtsChunksBounded(rows, { resumeKey: STALE_KEY, gateStrategyWork: false });
    expect(result.complete).toBe(true);

    // The A content is genuinely back in FTS, not merely re-keyed in the side index.
    const live = getDb()
      .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE content_hash = ? AND accession = ?")
      .get("stale-A", STALE_KEY.accession) as { n: number };
    expect(live.n).toBeGreaterThan(0);
  });
});

describe("document_chunks_fts_index occurrence index (migration 88)", () => {
  it("resolves an occurrence lookup with a SEARCH, not a full-index SCAN", async () => {
    const { getDb } = await import("../src/lib/db");
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT content_hash FROM document_chunks_fts_index
         WHERE symbol = ? AND source = ? AND accession = ?`
      )
      .all(KEY.symbol, KEY.source, KEY.accession) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail).toContain("idx_document_chunks_fts_index_occurrence");
    expect(detail).toContain("SEARCH");
  });
});

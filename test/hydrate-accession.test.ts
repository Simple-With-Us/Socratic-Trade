import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyVersionedMigrations, getDb } from "../src/lib/db";
import { insertDocumentChunkFts, insertSecFiling } from "../src/lib/db-learning";
import { hashContent } from "../src/lib/rag/chunk";
import { eightKWritePath, writeCorpusFileSync } from "../src/lib/rag/corpus-layout";
import { hydrateAccession } from "../src/lib/rag/hydrate-accession";
import { sqliteAllOffLoop } from "../src/lib/rag/sqlite-all-offloop";
import { writeLocalArtifact } from "../src/lib/web-sources/sec-filings";

// ST-4542: wrap (not replace) the off-loop reader so a test can see which statements left the
// serving connection.  Behavior is the real worker pool.
vi.mock("../src/lib/rag/sqlite-all-offloop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rag/sqlite-all-offloop")>();
  return { ...actual, sqliteAllOffLoop: vi.fn(actual.sqliteAllOffLoop) };
});

const ACCESSION = "0001045810-26-000123";
const CIK = "0001045810";
const PARENT_1A =
  "Item 1A. Risk Factors. Export-control changes could reduce data-center demand and impair a going-concern assumption.";
const ITEM7 =
  "Item 7. MD&A. Revenue grew and we raised full-year guidance on data-center demand.";
const ITEM8_TABLE =
  "Item 8. Financial Statements. Table of cash flows for the quarter ended June 30.";
const EIGHT_K_BODY =
  "Item 5.02. Departure of Directors. The CFO resigned effective immediately and the board named an interim CFO.";

describe("hydrateAccession", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hydrate-acc-"));

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-hydrate-${randomUUID()}.db`)}`;
    process.env.DATA_DIR = dataDir;
    delete process.env.CORPUS_DIR;
    applyVersionedMigrations(getDb());
  });

  beforeEach(() => {
    getDb().exec(`
      DELETE FROM document_chunks_fts_index;
      DELETE FROM document_chunks_fts;
      DELETE FROM sec_filings;
    `);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parent/1A from chunks.json + FTS without network", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("hydrate must not hit the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const chunk1A = {
      text: PARENT_1A,
      parent_text: PARENT_1A,
      content_hash: hashContent(PARENT_1A),
      section: "1A. Risk Factors",
      itemCode: "1A"
    };
    const chunk7 = {
      text: ITEM7,
      parent_text: ITEM7,
      content_hash: hashContent(ITEM7),
      section: "7. Management's Discussion and Analysis",
      itemCode: "7"
    };
    await writeLocalArtifact(CIK, ACCESSION, 1, "chunks.json", JSON.stringify([chunk1A, chunk7]));
    insertDocumentChunkFts(chunk1A.content_hash, "NVDA", "sec-edgar", ACCESSION, PARENT_1A);
    insertDocumentChunkFts(chunk7.content_hash, "NVDA", "sec-edgar", ACCESSION, ITEM7);

    const fromChunks = await hydrateAccession({
      accession: ACCESSION,
      itemCode: "1A",
      symbol: "NVDA"
    });
    expect(fromChunks.missedReason).toBeUndefined();
    expect(fromChunks.source).toBe("chunks.json");
    expect(fromChunks.text).toContain("Risk Factors");
    expect(fromChunks.text).toContain("going-concern");
    expect(fetchSpy).not.toHaveBeenCalled();

    const fromHash = await hydrateAccession({
      accession: `NVDA:${ACCESSION}:10-K`,
      content_hash: chunk1A.content_hash,
      symbol: "NVDA"
    });
    expect(fromHash.text).toContain("Export-control");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads 8-K sidecar without fetch", async () => {
    const accession = "0001045810-26-000801";
    const fetchSpy = vi.fn(async () => {
      throw new Error("hydrate must not hit the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    writeCorpusFileSync(eightKWritePath(accession, "main.txt"), EIGHT_K_BODY);
    const result = await hydrateAccession({ accession, symbol: "NVDA" });
    expect(result.missedReason).toBeUndefined();
    expect(result.source).toBe("eight-k");
    expect(result.text).toContain("interim CFO");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("FTS with itemCode does not return a non-matching Item 8 table as the 1A hit", async () => {
    const accession = "0001045810-26-000802";
    const hash1A = hashContent(PARENT_1A);
    for (let i = 0; i < 30; i += 1) {
      const table = `${ITEM8_TABLE} row ${i}`;
      insertDocumentChunkFts(hashContent(table), "NVDA", "sec-edgar", accession, table);
    }
    insertDocumentChunkFts(hash1A, "NVDA", "sec-edgar", accession, PARENT_1A);

    const result = await hydrateAccession({
      accession,
      itemCode: "1A",
      symbol: "NVDA"
    });
    expect(result.missedReason).toBeUndefined();
    expect(result.source).toBe("fts");
    expect(result.text).toContain("Risk Factors");
    expect(result.text).toContain("going-concern");
    expect(result.text).not.toContain("Financial Statements");
  });

  it("does not need listSecAccessionDirs when cik is known", async () => {
    const accession = "0001045810-26-000803";
    insertSecFiling({
      accession,
      cik: CIK,
      ticker: "NVDA",
      form: "10-K",
      filedAt: "2026-01-15",
      acceptedAt: "2026-01-15T21:00:00.000Z",
      status: "parsed",
      chunkCount: 0
    });

    // Decoy under a different CIK — only a blind walk would find it.
    const otherCik = "0000320193";
    const decoyDir = join(dataDir, "corpus", "sec", otherCik, accession);
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(
      join(decoyDir, "1-chunks.json"),
      JSON.stringify([
        {
          text: PARENT_1A,
          parent_text: PARENT_1A,
          content_hash: hashContent(PARENT_1A),
          section: "1A. Risk Factors",
          itemCode: "1A"
        }
      ]),
      "utf8"
    );

    const missedWalk = await hydrateAccession({
      accession,
      itemCode: "1A",
      symbol: "NVDA"
    });
    expect(missedWalk.source).not.toBe("chunks.json");

    await writeLocalArtifact(
      CIK,
      accession,
      1,
      "chunks.json",
      JSON.stringify([
        {
          text: PARENT_1A,
          parent_text: PARENT_1A,
          content_hash: hashContent(PARENT_1A),
          section: "1A. Risk Factors",
          itemCode: "1A"
        }
      ])
    );
    const fromKnownCik = await hydrateAccession({
      accession,
      itemCode: "1A",
      symbol: "NVDA"
    });
    expect(fromKnownCik.source).toBe("chunks.json");
    expect(fromKnownCik.text).toContain("Risk Factors");
  });

  it("fail-opens on a miss without throwing", async () => {
    const missed = await hydrateAccession({ accession: "0000000000-00-000000", itemCode: "1A" });
    expect(missed.text).toBe("");
    expect(missed.missedReason).toBe("missing_local_copy");
  });

  it("runs the FTS accession scan off the serving connection (ST-4542)", async () => {
    const text = "Item 1A. Risk Factors. Only the FTS copy holds this sentence about supplier concentration.";
    insertDocumentChunkFts(hashContent(text), "NVDA", "sec-edgar", "0001045810-26-000999", text);
    vi.mocked(sqliteAllOffLoop).mockClear();
    const hit = await hydrateAccession({ accession: "0001045810-26-000999", itemCode: "1A" });
    expect(hit.source).toBe("fts");
    expect(hit.text).toContain("supplier concentration");
    const sqls = vi.mocked(sqliteAllOffLoop).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("document_chunks_fts") && q.includes("GLOB"))).toBe(true);
  });

  it("finds a transcript by source_meta or symbol off the serving connection (ST-4542)", async () => {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO earningscalls_transcripts
           (symbol, fiscal_year, fiscal_quarter, content, fetched_at, source_meta)
         VALUES ('NVDA', 2025, 1, ?, '2025-05-01T00:00:00Z', 'meta')`
      )
      .run("Operator: welcome to the call. ".repeat(10));
    vi.mocked(sqliteAllOffLoop).mockClear();
    // No row for 2099Q4, so the keyed lookup misses and the symbol/source_meta scan answers.
    const hit = await hydrateAccession({ accession: "earningscalls:NVDA:2099Q4" });
    expect(hit.source).toBe("transcript");
    expect(hit.text).toContain("welcome to the call");
    const sqls = vi.mocked(sqliteAllOffLoop).mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("earningscalls_transcripts") && q.includes("source_meta LIKE"))).toBe(true);
  });
});

// Tests for the full-filing RAG ingestion pipeline (10-K/10-Q → storeDocument → ingested_accessions).
//
// Coverage:
//  1. Pure-function parsers: normalizeAccession, padCik, parseRecentFilings, extractFilingText.
//  2. ingested_accessions de-dup (hasIngestedAccession / insertIngestedAccession via real SQLite).
//  3. ingestFiling: de-dup skip path + actual ingest path (mocked storeDocument/fetchFilingHtml).
//  4. Free-tier 1-filing cap in refreshFilingBodies.
//  5. Point-in-time test: isWithinAsOf drops a chunk whose acceptance_datetime is after asOf
//     (pinning the lookahead guard once bodies carry real acceptance_datetime).

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RagEmbedRerankProvider } from "../src/lib/rag-metering";

// ── Set up an isolated per-run SQLite DB before anything else ─────────────────
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-filings-${randomUUID()}.db`)}`;
});

// ── Vitest hoisted mocks ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  politeFetchText: vi.fn<(url: string) => Promise<string>>(),
  secUserAgent: vi.fn(() => "test-agent"),
  sleep: vi.fn(() => Promise.resolve()),
  runRateLimited: vi.fn(
    async <T, R>(items: T[], _delay: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> =>
      Promise.all(items.map((item, idx) => fn(item, idx)))
  ),
  loadTickerCikMap: vi.fn<() => Promise<Record<string, string>>>(async () => ({
    AAPL: "320193",
    MSFT: "789019"
  })),
  storeDocument: vi.fn(),
  storeContexts: vi.fn().mockResolvedValue({ attempted: 1, indexed: 1 }),
  getEnrichmentProvider: vi.fn(() => ({
    name: "test",
    configured: true,
    enrich: vi.fn(async (symbols: string[]) => {
      const res: Record<string, unknown> = {};
      for (const s of symbols) {
        res[s] = { companyName: `${s} Inc.`, sector: "Technology", asOf: "2024-10-01" };
      }
      return res;
    })
  })),
  hasIngestTextBudget: vi.fn(() => true),
  hasPineconeWriteBudget: vi.fn(() => true),
  insertSecArtifact: vi.fn(),
  audit: vi.fn(),
  // Real implementation by default (wired in the vi.mock factory below via importOriginal); a
  // test overrides it with .mockRejectedValueOnce to force ingestFiling's `skipped: true, error:
  // "..."` (document-commit-proof-lost) branch without faking a real DB fault.
  mirrorFtsChunksBounded: vi.fn(),
  setInternalSetting: vi.fn(),
  getInternalSetting: vi.fn(),
  // Defaults to "voyage" so every pre-existing VECTOR_EMBED_BATCH_DELAY_MS-driven test below is
  // unaffected; only the provider-aware-gate tests override this. Typed explicitly as the full
  // union (not narrowed by inference to the literal "voyage") so mockReturnValue accepts the
  // other providers.
  activeEmbeddingProvider: vi.fn<(userId?: string) => RagEmbedRerankProvider>(() => "voyage")
}));

vi.mock("../src/lib/web-sources/http", () => ({
  politeFetchText: mocks.politeFetchText,
  secUserAgent: mocks.secUserAgent,
  sleep: mocks.sleep,
  runRateLimited: mocks.runRateLimited,
  BROWSER_UA: "Mozilla/5.0 test"
}));

vi.mock("../src/lib/web-sources/sec8k", () => ({
  loadTickerCikMap: mocks.loadTickerCikMap
}));

vi.mock("../src/lib/data-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/data-providers")>();
  return { managedVectorLedgerAuthority: vi.fn(),
    ...actual,
    getEnrichmentProvider: mocks.getEnrichmentProvider
  };
});

// We do NOT mock db here — we use the real SQLite via DATABASE_URL
// so hasIngestedAccession / insertIngestedAccession go through the real schema.
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { managedVectorLedgerAuthority: vi.fn(),
    ...actual,
    insertSecArtifact: mocks.insertSecArtifact,
    runWithActiveVectorCommitProof: <T>(_proof: unknown, work: () => T) => work()
  };
});

vi.mock("../src/lib/rag/mirror-fts-bounded", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rag/mirror-fts-bounded")>();
  mocks.mirrorFtsChunksBounded.mockImplementation(actual.mirrorFtsChunksBounded);
  return { ...actual, mirrorFtsChunksBounded: mocks.mirrorFtsChunksBounded };
});

vi.mock("../src/lib/db-vector-commits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-vector-commits")>();
  return { managedVectorLedgerAuthority: vi.fn(),
    ...actual,
    runWithActiveVectorCommitProof: <T>(_proof: unknown, work: () => T) => work()
  };
});

// storeDocument is dynamic-imported inside ingestFiling; partially mock the module so
// isWithinAsOf (a pure function) is still the real implementation.
vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return {
    ...actual,
    managedVectorLedgerAuthority: vi.fn(),
    storeDocument: async (...args: Parameters<typeof actual.storeDocument>) => {
      const result = await mocks.storeDocument(...args);
      return result?.documentComplete === true
        ? { ...result, managedCommitProof: result.managedCommitProof ?? { commitId: "test:sec", attemptToken: "test:sec" } }
        : result;
    },
    storeContexts: mocks.storeContexts,
    hasIngestTextBudget: mocks.hasIngestTextBudget,
    hasPineconeWriteBudget: mocks.hasPineconeWriteBudget,
    activeEmbeddingProvider: mocks.activeEmbeddingProvider
  };
});

function isFullBodyFilingDoc(doc: { doc_id?: string }): boolean {
  const id = String(doc.doc_id ?? "");
  return !id.startsWith("abstract:") && !id.includes(":section:");
}

function persistOk(doc: { doc_id?: string }) {
  const full = isFullBodyFilingDoc(doc);
  const attempted = full ? 3 : 1;
  return {
    attempted,
    indexed: attempted,
    documentComplete: true,
    managedCommitProof: {
      documentComplete: true,
      attempted,
      indexed: attempted
    }
  };
}

function persistFailBody(doc: { doc_id?: string }, bodyResult: Record<string, unknown>) {
  if (!isFullBodyFilingDoc(doc)) return persistOk(doc);
  return bodyResult;
}

function bodyStoreCalls() {
  return mocks.storeDocument.mock.calls.filter(([doc]) =>
    isFullBodyFilingDoc(doc as { doc_id?: string })
  );
}

afterEach(async () => {
  vi.clearAllMocks();
  mocks.hasIngestTextBudget.mockImplementation(() => true);
  mocks.hasPineconeWriteBudget.mockImplementation(() => true);
  mocks.insertSecArtifact.mockImplementation(() => undefined);
  mocks.storeContexts.mockResolvedValue({ attempted: 1, indexed: 1 });
  mocks.getEnrichmentProvider.mockImplementation(() => ({
    name: "test",
    configured: true,
    enrich: vi.fn(async (symbols: string[]) => Object.fromEntries(
      symbols.map((symbol) => [symbol, {
        companyName: `${symbol} Inc.`,
        sector: "Technology",
        asOf: "2024-10-01"
      }])
    ))
  }));
  mocks.activeEmbeddingProvider.mockReturnValue("voyage");
  delete process.env.VECTOR_EMBED_BATCH_DELAY_MS;

  try {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    db.prepare("DELETE FROM sec_filings").run();
    db.prepare("DELETE FROM sec_artifacts").run();
    db.prepare("DELETE FROM ingested_accessions").run();
    db.prepare("DELETE FROM document_chunks_fts_index").run();
    db.prepare("DELETE FROM document_chunks_fts").run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'operation_lease:%'").run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'webSource:%'").run();
  } catch (err) {
    // Ignore database clean-up errors before DB is initialized
  }
});

// ── 1. Pure parser tests ──────────────────────────────────────────────────────

describe("normalizeAccession", () => {
  it("normalises dashed accession to standard form", async () => {
    const { normalizeAccession } = await import("../src/lib/web-sources/sec-filings");
    expect(normalizeAccession("0000320193-23-000005")).toBe("0000320193-23-000005");
  });
  it("normalises no-dash accession to dashed form", async () => {
    const { normalizeAccession } = await import("../src/lib/web-sources/sec-filings");
    expect(normalizeAccession("000032019323000005")).toBe("0000320193-23-000005");
  });
  it("passes through unusual forms unchanged", async () => {
    const { normalizeAccession } = await import("../src/lib/web-sources/sec-filings");
    expect(normalizeAccession("short")).toBe("short");
  });
});

describe("padCik", () => {
  it("pads short CIK to 10 digits", async () => {
    const { padCik } = await import("../src/lib/web-sources/sec-filings");
    expect(padCik("320193")).toBe("0000320193");
    expect(padCik(320193)).toBe("0000320193");
  });
  it("leaves 10-digit CIK unchanged", async () => {
    const { padCik } = await import("../src/lib/web-sources/sec-filings");
    expect(padCik("0001318605")).toBe("0001318605");
  });
});

describe("parseRecentFilings", () => {
  it("returns newest 10-K and 2 most-recent 10-Qs, filters other form types", async () => {
    const { parseRecentFilings } = await import("../src/lib/web-sources/sec-filings");
    const json = {
      filings: {
        recent: {
          accessionNumber: [
            "0000320193-24-000001", // 10-K newest
            "0000320193-24-000002", // 10-Q 1
            "0000320193-24-000003", // 10-Q 2
            "0000320193-24-000004", // 10-Q 3 (should be dropped — limitPerType=2)
            "0000320193-24-000005"  // 8-K (should be filtered out)
          ],
          form: ["10-K", "10-Q", "10-Q", "10-Q", "8-K"],
          filingDate: ["2024-11-01", "2024-08-02", "2024-05-03", "2024-02-04", "2024-10-05"],
          acceptanceDateTime: [
            "2024-11-01T00:00:00.000Z",
            "2024-08-02T00:00:00.000Z",
            "2024-05-03T00:00:00.000Z",
            "2024-02-04T00:00:00.000Z",
            "2024-10-05T00:00:00.000Z"
          ],
          primaryDocument: ["aapl-20241101.htm", "aapl-20240802.htm", "aapl-20240503.htm", "aapl-20240204.htm", "aapl-8k.htm"]
        }
      }
    };

    const refs = parseRecentFilings(json, "320193", ["10-K", "10-Q"], 2);
    expect(refs).toHaveLength(3); // 1 10-K + 2 10-Qs
    expect(refs[0].docType).toBe("10-K");
    expect(refs[0].accession).toBe("0000320193-24-000001");
    expect(refs[0].url).toContain("aapl-20241101.htm");
    expect(refs[1].docType).toBe("10-Q");
    expect(refs[2].docType).toBe("10-Q");
    // The 3rd 10-Q and the 8-K are absent
    expect(refs.every((r) => r.docType !== "8-K" as string)).toBe(true);
  });

  it("returns empty array when filings.recent is missing", async () => {
    const { parseRecentFilings } = await import("../src/lib/web-sources/sec-filings");
    expect(parseRecentFilings({}, "320193", ["10-K"], 1)).toEqual([]);
    expect(parseRecentFilings({ filings: {} }, "320193", ["10-K"], 1)).toEqual([]);
  });
});

// ── 2. extractFilingText ─────────────────────────────────────────────────────

describe("extractFilingText", () => {
  it("strips script/style blocks", async () => {
    const { extractFilingText } = await import("../src/lib/web-sources/sec-filings");
    const html = `<html><head><script>alert(1)</script><style>body{color:red}</style></head><body><p>Hello world</p></body></html>`;
    const text = extractFilingText(html);
    expect(text).toContain("Hello world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("preserves heading text and table content as plain lines", async () => {
    const { extractFilingText } = await import("../src/lib/web-sources/sec-filings");
    const html = `<h2>Risk Factors</h2><p>We face substantial competition.</p><table><tr><td>2023</td><td>$100M</td></tr></table>`;
    const text = extractFilingText(html);
    expect(text).toContain("Risk Factors");
    expect(text).toContain("We face substantial competition.");
    expect(text).toContain("2023");
    expect(text).toContain("$100M");
  });

  it("decodes HTML entities (ampersand, quote, numeric)", async () => {
    const { extractFilingText } = await import("../src/lib/web-sources/sec-filings");
    // Note: &lt;target&gt; decodes to <target> which is then stripped by the tag-stripper —
    // that is correct behavior (tag-encoded content is treated as markup, not text).
    const html = `<p>Revenue &amp; profit &quot;exceeded&quot; &#8212; Q4</p>`;
    const text = extractFilingText(html);
    expect(text).toContain('Revenue & profit "exceeded"');
    expect(text).toContain("Q4");
  });

  it("collapses excessive whitespace", async () => {
    const { extractFilingText } = await import("../src/lib/web-sources/sec-filings");
    const html = `<p>Line   one</p><p>   Line two   </p>`;
    const text = extractFilingText(html);
    // Must not have 3+ consecutive newlines
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).toContain("Line one");
    expect(text).toContain("Line two");
  });
});

// ── 3. ingested_accessions de-dup via real SQLite ────────────────────────────

describe("ingested_accessions de-dup (real SQLite)", () => {
  // Re-import db helpers fresh (the DATABASE_URL is set in beforeAll).
  it("hasIngestedAccession returns false before insertion, true after", async () => {
    const { hasIngestedAccession, insertIngestedAccession } = await import("../src/lib/db");
    const acc = `test-acc-${randomUUID()}`;
    expect(hasIngestedAccession(acc, "10-K")).toBe(false);
    insertIngestedAccession(acc, "10-K", "AAPL", 42);
    expect(hasIngestedAccession(acc, "10-K")).toBe(true);
  });

  it("treats (accession, doc_type) as the composite key — different types don't collide", async () => {
    const { hasIngestedAccession, insertIngestedAccession } = await import("../src/lib/db");
    const acc = `test-acc-${randomUUID()}`;
    insertIngestedAccession(acc, "10-K", "AAPL", 10);
    expect(hasIngestedAccession(acc, "10-K")).toBe(true);
    expect(hasIngestedAccession(acc, "10-Q")).toBe(false); // different doc_type
  });

  it("INSERT OR IGNORE is idempotent — double-insert doesn't throw", async () => {
    const { hasIngestedAccession, insertIngestedAccession } = await import("../src/lib/db");
    const acc = `test-acc-${randomUUID()}`;
    insertIngestedAccession(acc, "10-K", "AAPL", 5);
    expect(() => insertIngestedAccession(acc, "10-K", "AAPL", 5)).not.toThrow();
    expect(hasIngestedAccession(acc, "10-K")).toBe(true);
  });
});

// ── 4. ingestFiling — de-dup skip + actual ingest ────────────────────────────

describe("ingestFiling", () => {
  const makeRef = (acc?: string): import("../src/lib/web-sources/sec-filings").FilingRef => ({
    accession: acc ?? `0000000000-24-${String(Math.random()).slice(2, 8)}`,
    docType: "10-K",
    filedAt: "2024-11-01",
    acceptanceDateTime: "2024-11-01T20:00:00.000Z",
    primaryDoc: "aapl-10k.htm",
    url: "https://www.sec.gov/Archives/edgar/data/320193/0000000000-24-000001/aapl-10k.htm"
  });

  it("returns {skipped:true} when accession already in ingested_accessions", async () => {
    const { insertIngestedAccession } = await import("../src/lib/db");
    const ref = makeRef();
    insertIngestedAccession(ref.accession, ref.docType, "AAPL", 100);

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);
    expect(result.skipped).toBe(true);
    expect(result.chunks).toBe(0);
    expect(mocks.politeFetchText).not.toHaveBeenCalled();
  });

  it("fetches, extracts, stores, and records de-dup on success", async () => {
    const ref = makeRef();
    const fakeHtml = "<h2>Risk Factors</h2><p>".concat("We face substantial risks. ".repeat(20)).concat("</p>");

    mocks.politeFetchText.mockResolvedValueOnce(fakeHtml);
    mocks.storeDocument.mockImplementation(async (doc) => persistOk(doc));

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);

    expect(result.skipped).toBe(false);
    expect(result.chunks).toBe(3);
    expect(result.error).toBeUndefined();

    // Check that de-dup was recorded
    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(ref.accession, ref.docType)).toBe(true);

    // Verify storeDocument was called with scope-friendly args (userId='local')
    expect(mocks.storeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        doc_id: `AAPL:${ref.accession}:${ref.docType}`,
        ticker: "AAPL",
        doc_type: "10-k",
        source: "sec-edgar",
        acceptance_datetime: ref.acceptanceDateTime,
        text: expect.stringMatching(/substantial risks/i)
      }),
      "local",
      { parserRevision: "sec-edgar-filing-v2" }
    );
    const stored = mocks.storeDocument.mock.calls.at(-1)?.[0] as { text?: string };
    expect(stored.text).not.toMatch(/<h2|<p>/i);

    const { readLocalArtifact } = await import("../src/lib/web-sources/sec-filings");
    const chunksJson = await readLocalArtifact("0000320193", ref.accession, 1, "chunks.json");
    expect(chunksJson).toBeTruthy();
    const parsed = JSON.parse(chunksJson ?? "[]") as Array<{ text?: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((chunk) => /substantial risks/i.test(chunk.text ?? ""))).toBe(true);
  });

  it("defers ingest when strategy work is in flight during FTS mirror", async () => {
    const { insertStrategyRun, finishStrategyRun } = await import("../src/lib/db-execution");
    const runId = randomUUID();
    const userId = `sec-filing-strategy-${randomUUID()}`;
    insertStrategyRun(runId, userId);

    const ref = makeRef();
    const fakeHtml = "<h2>Risk Factors</h2><p>".concat("We face substantial risks. ".repeat(20)).concat("</p>");
    mocks.politeFetchText.mockResolvedValueOnce(fakeHtml);
    mocks.storeDocument.mockImplementation(async (doc) => persistOk(doc));

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);

    finishStrategyRun(runId, "failed", "test release", userId);

    expect(result.skipped).toBe(true);
    expect(result.deferredStrategy).toBe(true);
    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(ref.accession, ref.docType)).toBe(false);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("returns error and does NOT record de-dup on storeDocument failure", async () => {
    const ref = makeRef();
    const fakeHtml = "<p>".concat("Risk text. ".repeat(30)).concat("</p>");

    mocks.politeFetchText.mockResolvedValueOnce(fakeHtml);
    mocks.storeDocument.mockImplementation(async (doc) =>
      persistFailBody(doc, { attempted: 2, indexed: 0, error: "Voyage 429" })
    );

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);

    expect(result.error).toBe("Voyage 429");

    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(ref.accession, ref.docType)).toBe(false);
  });

  // P1 fix (2026-08-23): ingestFiling can return `skipped: true` together with a real `error`
  // (document-commit-proof-missing/-lost) — a genuine failure that also happened to stop short
  // of a full ingest. This pins that `skipped` and `error` are not mutually exclusive on the
  // ingestFiling contract, which is exactly what refreshFilingBodiesUnlocked's aggregation (see
  // the next describe block) previously got wrong.
  it("returns skipped:true WITH the error when the post-commit FTS mirror fails (document-commit-proof-lost)", async () => {
    const ref = makeRef();
    const fakeHtml = "<p>".concat("Risk text. ".repeat(30)).concat("</p>");

    mocks.politeFetchText.mockResolvedValueOnce(fakeHtml);
    mocks.storeDocument.mockImplementation(async (doc) => persistOk(doc));
    // ingestFiling's full-body path calls mirrorFtsChunksBounded TWICE: once inside
    // persistLocalComplete (pre-commit FTS ledger, not wrapped in a try/catch — a failure there
    // must propagate, not be swallowed as skipped:true) and once inside ingestFiling's own
    // try/catch AFTER storeDocument commits (the one this test targets). Let the first succeed
    // and only fail the second.
    mocks.mirrorFtsChunksBounded
      .mockResolvedValueOnce({ offset: 0, complete: true, abortedByStrategy: false })
      .mockRejectedValueOnce(new Error("sqlite: disk I/O error"));

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);

    expect(result.skipped).toBe(true);
    expect(result.error).toBe("sqlite: disk I/O error");

    // The accession must NOT be recorded as ingested — the commit proof was lost, not delivered.
    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(ref.accession, ref.docType)).toBe(false);
  });

  it("propagates the shared RAG lease guard into storeDocument", async () => {
    const ref = makeRef();
    mocks.politeFetchText.mockResolvedValueOnce(
      "<p>".concat("Risk text with durable ownership. ".repeat(30)).concat("</p>")
    );
    mocks.storeDocument.mockImplementation(async (doc) => persistOk(doc));
    const controller = new AbortController();
    const guard = { assertOwnership: vi.fn(), signal: controller.signal };
    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");

    await ingestFiling("AAPL", ref, "local", guard);

    expect(mocks.storeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ source: "sec-edgar", doc_id: `AAPL:${ref.accession}:${ref.docType}` }),
      "local",
      { leaseGuard: guard, parserRevision: "sec-edgar-filing-v2" }
    );
  });

  it("getCikForTicker pads a real CIK and refuses the sentinel 0000000000", async () => {
    mocks.loadTickerCikMap.mockResolvedValueOnce({ AAPL: "320193", ZZZZ: "0000000000" });
    const { getCikForTicker } = await import("../src/lib/web-sources/sec-filings");
    expect(await getCikForTicker("AAPL")).toBe("0000320193");
    expect(await getCikForTicker("ZZZZ")).toBeNull();
  });

  it("refuses ingest when the ticker has no CIK (no sentinel 0000000000)", async () => {
    mocks.loadTickerCikMap.mockResolvedValueOnce({});
    const ref = makeRef();
    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("ZZZZ", ref);
    expect(result.error).toMatch(/unknown CIK/);
    expect(mocks.politeFetchText).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("returns error and does NOT record de-dup when fetch fails", async () => {
    const ref = makeRef();
    mocks.politeFetchText.mockRejectedValueOnce(new Error("HTTP 503 for url"));

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);

    expect(result.error).toMatch(/fetch failed/);
    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(ref.accession, ref.docType)).toBe(false);
  });

  it("stops after the filing fetch when the shared RAG lease is lost", async () => {
    const ref = makeRef();
    let lost = false;
    mocks.politeFetchText.mockImplementationOnce(async () => {
      lost = true;
      return "<p>".concat("Lease-sensitive filing text. ".repeat(30)).concat("</p>");
    });
    const guard = {
      assertOwnership: vi.fn(() => {
        if (lost) throw new Error("test filing lease lost");
      })
    };
    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");

    await expect(ingestFiling("AAPL", ref, "local", guard)).rejects.toThrow("test filing lease lost");

    expect(mocks.insertSecArtifact).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("stops after the artifact insert when the shared RAG lease is lost", async () => {
    const ref = makeRef();
    let ownershipChecks = 0;
    mocks.politeFetchText.mockResolvedValueOnce(
      "<p>".concat("Lease-sensitive filing text. ".repeat(30)).concat("</p>")
    );
    const guard = {
      assertOwnership: vi.fn(() => {
        ownershipChecks += 1;
        if (ownershipChecks >= 8) throw new Error("test artifact lease lost");
      })
    };
    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");

    await expect(ingestFiling("AAPL", ref, "local", guard)).rejects.toThrow("test artifact lease lost");

    expect(ownershipChecks).toBeGreaterThanOrEqual(8);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });
});

// ── 4b. refreshFilingBodies error aggregation (P1 fix, 2026-08-23) ───────────
//
// refreshFilingBodiesUnlocked used to check `ingestResult.skipped` BEFORE `ingestResult.error`,
// so a per-filing result of `{ skipped: true, error: "..." }` (a genuine failure that also
// stopped short of a full ingest — see the ingestFiling test above) took the "skipped" branch
// and the error was never pushed into `result.errors`. The refresh then reported success
// (an empty errors array) while a filing had actually failed, so nothing downstream — the
// dashboard audit row, any monitor keyed on `errors.length > 0` — ever saw it.
describe("refreshFilingBodies error aggregation (P1 fix)", () => {
  it("records the real error in result.errors instead of silently counting it as a skip", async () => {
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });
    const accession = `0000320193-24-${randomUUID().slice(0, 6)}`;
    mocks.politeFetchText
      // AAPL submissions JSON: one filing.
      .mockResolvedValueOnce(
        JSON.stringify({
          filings: {
            recent: {
              accessionNumber: [accession],
              form: ["10-K"],
              filingDate: ["2024-11-01"],
              acceptanceDateTime: ["2024-11-01T00:00:00.000Z"],
              primaryDocument: ["aapl-10k.htm"]
            }
          }
        })
      )
      // The filing body itself.
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));

    mocks.storeDocument.mockImplementation(async (doc) => persistOk(doc));
    // ingestFiling's full-body path calls mirrorFtsChunksBounded TWICE (see the ingestFiling
    // test above): let the first (persistLocalComplete's pre-commit mirror) succeed, and only
    // fail the second — the one whose catch returns `{ skipped: true, error: "..." }` WITHOUT
    // throwing. A thrown exception from ingestFiling was already handled correctly by the
    // pre-existing `catch (err)` below (pushed as "... threw: ..."); this fix is specifically
    // about a NORMAL, non-throwing ingestFiling return that still carries a real error.
    mocks.mirrorFtsChunksBounded
      .mockResolvedValueOnce({ offset: 0, complete: true, abortedByStrategy: false })
      .mockRejectedValueOnce(new Error("sqlite: disk I/O error"));

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true });

    expect(result.attempted).toBe(1);
    // The bug: this used to be 0 while `skipped` absorbed the failure silently.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(accession);
    expect(result.errors[0]).toContain("sqlite: disk I/O error");
    // Confirms this went through the ingestResult.error branch (the actual fix), not the
    // pre-existing "ingestFiling(...) threw" catch a few lines below it in the source, which was
    // already correct before this fix and would otherwise make this test pass for the wrong reason.
    expect(result.errors[0]).not.toContain("threw");
    // A real failure must not also be counted as a benign skip or a success.
    expect(result.skipped).toBe(0);
    expect(result.ingested).toBe(0);

    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(accession, "10-K")).toBe(false);
  });
});

// ── 5. Free-tier 1-filing cap in refreshFilingBodies ─────────────────────────

describe("refreshFilingBodies free-tier cap", () => {
  it("processes at most 1 filing on free tier (VECTOR_EMBED_BATCH_DELAY_MS=21000)", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "21000";

    // CIK map: AAPL + MSFT
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });

    // 2 filings per symbol, all unindexed (random accessions)
    mocks.politeFetchText
      // AAPL submissions JSON
      .mockResolvedValueOnce(
        JSON.stringify({
          filings: {
            recent: {
              accessionNumber: [`0000320193-24-${randomUUID().slice(0, 6)}`, `0000320193-24-${randomUUID().slice(0, 6)}`],
              form: ["10-K", "10-Q"],
              filingDate: ["2024-11-01", "2024-08-02"],
              acceptanceDateTime: ["2024-11-01T00:00:00.000Z", "2024-08-02T00:00:00.000Z"],
              primaryDocument: ["aapl-10k.htm", "aapl-10q.htm"]
            }
          }
        })
      )
      // MSFT submissions JSON
      .mockResolvedValueOnce(
        JSON.stringify({
          filings: {
            recent: {
              accessionNumber: [`0000789019-24-${randomUUID().slice(0, 6)}`, `0000789019-24-${randomUUID().slice(0, 6)}`],
              form: ["10-K", "10-Q"],
              filingDate: ["2024-11-02", "2024-08-03"],
              acceptanceDateTime: ["2024-11-02T00:00:00.000Z", "2024-08-03T00:00:00.000Z"],
              primaryDocument: ["msft-10k.htm", "msft-10q.htm"]
            }
          }
        })
      )
      // The one filing body that gets fetched
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));

    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined, documentComplete: true });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now());

    // Free-tier cap: at most 1 filing was ATTEMPTED (ingested or skipped)
    expect(result.attempted).toBeLessThanOrEqual(1);
  });

  it("does NOT apply the free-tier cap when the active provider is bge-m3 (openrouter), even with a stale free-tier-looking VECTOR_EMBED_BATCH_DELAY_MS", async () => {
    // Regression test for the 2026-07-19 fix: isFreeTier() used to be keyed purely off
    // VECTOR_EMBED_BATCH_DELAY_MS (a Voyage-pricing-era signal), so migrating RAG_EMBED_PROVIDER
    // to openrouter/siliconflow without also remembering to zero out this unrelated env var left
    // ingestion silently pinned to 1 filing/run regardless of the new provider's real capacity.
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "21000"; // free-tier-looking value, left over from Voyage
    mocks.activeEmbeddingProvider.mockReturnValue("openrouter");

    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });
    mocks.politeFetchText
      .mockResolvedValueOnce(
        JSON.stringify({
          filings: {
            recent: {
              accessionNumber: [`0000320193-24-${randomUUID().slice(0, 6)}`, `0000320193-24-${randomUUID().slice(0, 6)}`],
              form: ["10-K", "10-Q"],
              filingDate: ["2024-11-01", "2024-08-02"],
              acceptanceDateTime: ["2024-11-01T00:00:00.000Z", "2024-08-02T00:00:00.000Z"],
              primaryDocument: ["aapl-10k.htm", "aapl-10q.htm"]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          filings: {
            recent: {
              accessionNumber: [`0000789019-24-${randomUUID().slice(0, 6)}`, `0000789019-24-${randomUUID().slice(0, 6)}`],
              form: ["10-K", "10-Q"],
              filingDate: ["2024-11-02", "2024-08-03"],
              acceptanceDateTime: ["2024-11-02T00:00:00.000Z", "2024-08-03T00:00:00.000Z"],
              primaryDocument: ["msft-10k.htm", "msft-10q.htm"]
            }
          }
        })
      )
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));

    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined, documentComplete: true });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now(), undefined, { force: true });

    // Paid-tier cap (200/run default) applies despite the stale free-tier env var — all 4
    // available filings (2 symbols x 2 filings each) get attempted, not capped at 1.
    expect(result.attempted).toBeGreaterThan(1);
    expect(result.attempted).toBe(4);
  });

  it("is a no-op when isFilingIngestDue returns false", async () => {
    // Set a recent lastAttempt stamp so the TTL gate fires
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:sec10k:lastAttempt", new Date().toISOString());

    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now());

    expect(result.attempted).toBe(0);
    expect(mocks.loadTickerCikMap).not.toHaveBeenCalled();
  });

  it("does not issue a submissions request after fundamentals work loses the shared lease", async () => {
    const { deleteInternalSetting } = await import("../src/lib/db");
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });
    mocks.getEnrichmentProvider.mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn(async () => {
        deleteInternalSetting("operation_lease:rag-reindex");
        return { managedVectorLedgerAuthority: vi.fn(), AAPL: { companyName: "Apple Inc." } };
      })
    });
    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");

    await expect(
      refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true })
    ).rejects.toThrow(/no longer owns|not active/i);

    expect(mocks.politeFetchText).not.toHaveBeenCalled();
  });
});

// ── 5b. Backfill knobs: force, explicit limit, TTL env, paid default ─────────
// Added 2026-07-09: the admin backfill route used to silently no-op behind the scheduler's
// TTL stamp and stay capped at 1 on free-tier env — defeating its purpose entirely.

describe("refreshFilingBodies force + explicit-limit + cadence knobs", () => {
  function mockSubmissions(cik: string, count: number): string {
    const suffix = () => randomUUID().slice(0, 6);
    return JSON.stringify({
      filings: {
        recent: {
          accessionNumber: Array.from({ length: count }, () => `${cik.padStart(10, "0")}-24-${suffix()}`),
          form: Array.from({ length: count }, (_, i) => (i % 2 === 0 ? "10-K" : "10-Q")),
          filingDate: Array.from({ length: count }, (_, i) => `2024-0${(i % 8) + 1}-01`),
          acceptanceDateTime: Array.from({ length: count }, (_, i) => `2024-0${(i % 8) + 1}-01T00:00:00.000Z`),
          primaryDocument: Array.from({ length: count }, (_, i) => `doc-${i}.htm`)
        }
      }
    });
  }

  afterEach(() => {
    delete process.env.SEC_FILING_INGEST_TTL_HOURS;
    delete process.env.SEC_FILING_RAG_MAX_PER_RUN;
  });

  it("force bypasses the ingest-TTL stamp (the admin backfill contract)", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:sec10k:lastAttempt", new Date().toISOString());

    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined, documentComplete: true });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true });

    expect(mocks.loadTickerCikMap).toHaveBeenCalled();
    expect(result.attempted).toBeGreaterThanOrEqual(1);
  });

  it("an explicit limit overrides the free-tier 1-filing cap (operator decision wins)", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "21000"; // free tier
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValueOnce(mockSubmissions("789019", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined, documentComplete: true });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now(), 3, { force: true });

    expect(result.attempted).toBe(3);
  });

  it("paid tier without env cap processes more than one filing per run (default raised from 1)", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0"; // paid tier
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValueOnce(mockSubmissions("789019", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined, documentComplete: true });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now(), undefined, { force: true });

    // All 4 pending filings fit under the paid default (25) — the old default of 1 made the
    // ~2,000-filing backlog take decades.
    expect(result.attempted).toBe(4);
  });

  it("an explicit SEC_FILING_RAG_MAX_PER_RUN=0 genuinely pauses the lane (2026-08-10 regression)", async () => {
    // A prior `n > 0` guard silently treated an explicit env of "0" as "unconfigured" and fell
    // through to the paid-tier default of 25 — a site-protective pause (set to stop the lane
    // during an incident) was a complete no-op while the operator believed it was in effect.
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0"; // paid tier
    process.env.SEC_FILING_RAG_MAX_PER_RUN = "0";
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });
    mocks.politeFetchText.mockResolvedValueOnce(mockSubmissions("320193", 2));

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true });

    expect(result.attempted).toBe(0);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("stops the run when the embed budget is exhausted — no doomed body fetches, tail deferred", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0"; // paid tier, cap 25
    mocks.hasIngestTextBudget.mockReturnValue(false); // budget already spent
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValueOnce(mockSubmissions("789019", 2));
    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now(), undefined, { force: true });

    // First pending filing hits the pre-flight, the whole tail is deferred un-recorded.
    expect(result.attempted).toBe(1);
    expect(result.ingested).toBe(0);
    // Cap-aware, breaker excluded: min(4 pending, 25 cap) - 1 processed.
    expect(result.deferredForBudget).toBe(3);
    expect(result.errors).toEqual([]);
    // Only the 2 submissions-JSON fetches happened — zero multi-MB filing-body downloads
    // (prod 2026-07-10: 20 wasted body fetches + a 20-event Sentry burst per run).
    expect(mocks.politeFetchText).toHaveBeenCalledTimes(2);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("defers the tail when the budget runs out mid-run, keeping earlier ingests", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.hasIngestTextBudget.mockReturnValueOnce(true).mockReturnValue(false); // 1 filing fits
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValueOnce(mockSubmissions("789019", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined, documentComplete: true });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now(), undefined, { force: true });

    expect(result.ingested).toBe(1);
    expect(result.attempted).toBe(2); // the successful one + the pre-flight that stopped the run
    expect(result.deferredForBudget).toBe(2); // min(4, 25) - 2 processed
    // One full-body write; processed abstracts/sections may also store.
    expect(bodyStoreCalls()).toHaveLength(1);
    expect(mocks.storeDocument).toHaveBeenCalled();
  });

  it("does not trust content-only dedup as occurrence completion and still advances fairly", async () => {
    // A stale/legacy caller may still report dedupComplete without a per-occurrence vector. It is
    // not capacity exhaustion and must not halt the tail, but it also must not complete accession.
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    let bodyWrites = 0;
    mocks.storeDocument.mockImplementation(async (doc) => {
      if (!isFullBodyFilingDoc(doc)) return persistOk(doc);
      bodyWrites += 1;
      if (bodyWrites === 1) {
        return { attempted: 7, indexed: 0, skipped: true, dedupComplete: true, documentComplete: true };
      }
      return persistOk(doc);
    });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true });

    expect(result.deferredForBudget).toBe(0); // did NOT stop
    expect(result.attempted).toBe(2); // both of AAPL's pending filings processed
    expect(result.skipped).toBe(1); // the healed one
    expect(result.ingested).toBe(1); // the second one embedded normally
    expect(bodyStoreCalls()).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("accepts an exact previously committed occurrence set as source completion", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    let bodyWrites = 0;
    mocks.storeDocument.mockImplementation(async (doc) => {
      if (!isFullBodyFilingDoc(doc)) return persistOk(doc);
      bodyWrites += 1;
      if (bodyWrites === 1) {
        return {
          attempted: 7,
          indexed: 0,
          skipped: true,
          reusedCommitted: true,
          documentComplete: true
        };
      }
      return persistOk(doc);
    });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now(), undefined, { force: true });

    expect(result).toMatchObject({ attempted: 2, ingested: 2, skipped: 0, deferredForBudget: 0 });
    expect(result.errors).toEqual([]);
  });

  it("keys-unconfigured IS a capacity stop: the run defers the tail", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.loadTickerCikMap.mockResolvedValue({ AAPL: "320193", MSFT: "789019" });
    mocks.politeFetchText
      .mockResolvedValueOnce(mockSubmissions("320193", 2))
      .mockResolvedValueOnce(mockSubmissions("789019", 2))
      .mockResolvedValue("<p>".concat("Annual report content. ".repeat(20)).concat("</p>"));
    mocks.storeDocument.mockImplementation(async (doc) =>
      persistFailBody(doc, { attempted: 5, indexed: 0, skipped: true, unconfigured: true })
    );

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now(), undefined, { force: true });

    expect(result.attempted).toBe(1);
    expect(result.ingested).toBe(0);
    expect(result.deferredForBudget).toBe(3);
    expect(bodyStoreCalls()).toHaveLength(1);
  });

  it("SEC_FILING_INGEST_TTL_HOURS shortens the ingest cadence", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    setInternalSetting("webSource:sec10k:lastAttempt", twoDaysAgo);

    const { isFilingIngestDue } = await import("../src/lib/web-sources/sec-filings");
    // Weekly pin: 2 days ago is NOT due yet.
    process.env.SEC_FILING_INGEST_TTL_HOURS = "168";
    expect(isFilingIngestDue()).toBe(false);
    // Paid daily cadence (catalog default 24h): 2 days ago IS due.
    process.env.SEC_FILING_INGEST_TTL_HOURS = "24";
    expect(isFilingIngestDue()).toBe(true);
  });

  it.each(["not-a-timestamp", { persisted: "state" }])(
    "fails open when the persisted cadence marker is invalid: %p",
    async (marker) => {
      const { setInternalSetting } = await import("../src/lib/db");
      setInternalSetting("webSource:sec10k:lastAttempt", marker);

      const { isFilingIngestDue } = await import("../src/lib/web-sources/sec-filings");
      expect(() => isFilingIngestDue()).not.toThrow();
      expect(isFilingIngestDue()).toBe(true);
    }
  );
});

// ── 6. Point-in-time guard: isWithinAsOf drops look-ahead chunks ─────────────
// This test pins the backtest lookahead-bias guard once 10-K bodies carry acceptance_datetime.

describe("isWithinAsOf point-in-time guard (vector-db)", () => {
  it("excludes a chunk whose acceptance_datetime is strictly after asOf", async () => {
    const { isWithinAsOf } = await import("../src/lib/vector-db");

    // A chunk from a 10-K filed on 2024-11-01 must NOT appear in a query as_of 2024-10-01
    expect(
      isWithinAsOf({ acceptance_datetime: "2024-11-01T00:00:00.000Z" }, "2024-10-01T00:00:00.000Z")
    ).toBe(false);
  });

  it("includes a chunk whose acceptance_datetime is at or before asOf", async () => {
    const { isWithinAsOf } = await import("../src/lib/vector-db");
    expect(
      isWithinAsOf({ acceptance_datetime: "2024-09-30T00:00:00.000Z" }, "2024-10-01T00:00:00.000Z")
    ).toBe(true);
  });

  it("includes a chunk that has no date at all (undated chunks are kept)", async () => {
    const { isWithinAsOf } = await import("../src/lib/vector-db");
    expect(isWithinAsOf({}, "2024-10-01T00:00:00.000Z")).toBe(true);
    expect(isWithinAsOf(undefined, "2024-10-01T00:00:00.000Z")).toBe(true);
  });

  it("includes all chunks when asOf is undefined (no time gate)", async () => {
    const { isWithinAsOf } = await import("../src/lib/vector-db");
    expect(isWithinAsOf({ acceptance_datetime: "2030-01-01T00:00:00.000Z" }, undefined)).toBe(true);
  });

  it("prefers acceptance_datetime over as_of over timestamp when multiple fields present", async () => {
    const { isWithinAsOf } = await import("../src/lib/vector-db");
    // acceptance_datetime says future (bad) → excluded, even though as_of says past (good)
    expect(
      isWithinAsOf(
        { acceptance_datetime: "2024-11-01T00:00:00.000Z", as_of: "2024-09-01T00:00:00.000Z" },
        "2024-10-01T00:00:00.000Z"
      )
    ).toBe(false);
  });
});

describe("Blended Fundamentals Profile Card Ingest", () => {
  it("builds a formatted fundamentals card correctly", async () => {
    const { buildFundamentalsContext } = await import("../src/lib/web-sources/sec-filings");
    const data = {
      companyName: "Apple Inc.",
      sector: "Technology",
      industry: "Consumer Electronics",
      marketCap: 3000000000000,
      price: 190.5,
      peRatio: 30.2,
      pbRatio: 45.1,
      eps: 6.3,
      fcfYield: 4.2,
      debtToEquity: 1.5,
      returnOnEquity: 150.5,
      returnOnAssets: 25.3,
      grossProfitMargin: 44.5,
      freeCashFlowYield: 3.8,
      revenueGrowth: 5.2,
      epsGrowth: 8.5,
      shortPercentOfFloat: 0.8,
      analystRating: "Buy",
      analystScore: 78,
      daysToEarnings: 15,
      institutionOwnershipPct: 58.2,
      dividendYield: 0.5,
      beta: 1.2,
      asOf: "2024-10-01"
    };

    const text = buildFundamentalsContext("AAPL", data);
    expect(text).toContain("Blended Corporate Fundamentals and Profile for AAPL (Apple Inc.).");
    expect(text).toContain("Sector: Technology. Industry: Consumer Electronics.");
    expect(text).toContain("Market Cap: $3,000B. Current Share Price: 190.5 USD.");
    expect(text).toContain("P/E Ratio: 30.2. P/B Ratio: 45.1. EPS (TTM): 6.3 USD.");
    expect(text).toContain("FCF Yield: 4.2%. Debt-to-Equity: 1.5.");
    expect(text).toContain("ROE: 150.5%. ROA: 25.3%.");
    expect(text).toContain("Gross Margin: 44.5%. Free Cash Flow Yield: 3.8%.");
    expect(text).toContain("Revenue Growth (YoY): 5.2%. EPS Growth (YoY): 8.5%.");
    expect(text).toContain("Short Interest (% of Float): 0.8%.");
    expect(text).toContain("Analyst Consensus Rating: Buy (Consensus Score: 78/100).");
    expect(text).toContain("Days to Next Earnings: 15. Institutional Ownership: 58.2%.");
    expect(text).toContain("Dividend Yield: 0.5%. Beta: 1.2.");
    expect(text).toContain("As of: 2024-10-01.");
  });

  it("handles empty/null/NaN data gracefully in card formatting", async () => {
    const { buildFundamentalsContext } = await import("../src/lib/web-sources/sec-filings");
    const text = buildFundamentalsContext("MSFT", {});
    expect(text).toContain("Blended Corporate Fundamentals and Profile for MSFT.");
    expect(text).toContain("Sector: N/A. Industry: N/A.");
    expect(text).toContain("Market Cap: N/A. Current Share Price: N/A.");
  });

  it("ingestFundamentalsCard calls storeContexts with correct data and dedup prefix", async () => {
    mocks.getEnrichmentProvider.mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockResolvedValue({
        AAPL: { companyName: "Apple Inc.", sector: "Technology", asOf: "2024-10-01" }
      })
    });
    mocks.storeContexts.mockResolvedValue({ attempted: 1, indexed: 1 });

    const { ingestFundamentalsCard } = await import("../src/lib/web-sources/sec-filings");
    const res = await ingestFundamentalsCard("AAPL");

    expect(res).toEqual({ skipped: false });
    expect(mocks.getEnrichmentProvider).toHaveBeenCalled();
    expect(mocks.storeContexts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          text: expect.stringContaining("Apple Inc."),
          metadata: expect.objectContaining({
            symbol: "AAPL",
            source: "blended-fundamentals",
            section: "Fundamentals",
            doc_type: "fundamentals"
          })
        })
      ],
      "local",
      { dedupKeyPrefix: "fundamentals" }
    );
  });

  it("rethrows lease loss after enrichment instead of converting it into a normal card error", async () => {
    let lost = false;
    mocks.getEnrichmentProvider.mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn(async () => {
        lost = true;
        return { managedVectorLedgerAuthority: vi.fn(), AAPL: { companyName: "Apple Inc." } };
      })
    });
    const guard = {
      assertOwnership: vi.fn(() => {
        if (lost) throw new Error("test fundamentals lease lost");
      })
    };
    const { ingestFundamentalsCard } = await import("../src/lib/web-sources/sec-filings");

    await expect(ingestFundamentalsCard("AAPL", "local", guard)).rejects.toThrow(
      "test fundamentals lease lost"
    );
    expect(mocks.storeContexts).not.toHaveBeenCalled();
  });
});

describe("sortBreadthFirst latest-then-deepen", () => {
  function ref(docType: "10-K" | "10-Q", filedAt: string, accession: string) {
    return {
      accession,
      docType,
      filedAt,
      acceptanceDateTime: `${filedAt}T00:00:00.000Z`,
      primaryDoc: "a.htm",
      url: "https://example.com"
    };
  }

  it("covers latest 10-K and 10-Q for every ticker before extra history", async () => {
    const { sortBreadthFirst } = await import("../src/lib/web-sources/sec-filings");
    const filings = [
      { ticker: "ZZZ", ref: ref("10-K", "2024-01-01", "k-old-zzz") },
      { ticker: "ZZZ", ref: ref("10-K", "2025-01-01", "k-new-zzz") },
      { ticker: "ZZZ", ref: ref("10-Q", "2025-05-01", "q1-zzz") },
      { ticker: "ZZZ", ref: ref("10-Q", "2025-08-01", "q2-zzz") },
      { ticker: "AAA", ref: ref("10-K", "2025-02-01", "k-aaa") },
      { ticker: "AAA", ref: ref("10-Q", "2025-06-01", "q-aaa") }
    ];
    const ordered = sortBreadthFirst(filings, new Set(["AAA"]));
    expect(ordered.map((row) => row.ref.accession)).toEqual([
      "k-aaa",
      "k-new-zzz",
      "q2-zzz",
      "q-aaa"
    ]);
  });
});


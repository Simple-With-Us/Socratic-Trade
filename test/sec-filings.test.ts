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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  loadCikMap: vi.fn<() => Promise<Record<string, string>>>(),
  storeDocument: vi.fn(),
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  getInternalSetting: vi.fn()
}));

vi.mock("../src/lib/web-sources/http", () => ({
  politeFetchText: mocks.politeFetchText,
  secUserAgent: mocks.secUserAgent,
  sleep: mocks.sleep,
  runRateLimited: mocks.runRateLimited
}));

vi.mock("../src/lib/web-sources/sec8k", () => ({
  loadCikMap: mocks.loadCikMap
}));

// We do NOT mock db here — we use the real SQLite via DATABASE_URL
// so hasIngestedAccession / insertIngestedAccession go through the real schema.

// storeDocument is dynamic-imported inside ingestFiling; partially mock the module so
// isWithinAsOf (a pure function) is still the real implementation.
vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return {
    ...actual,
    storeDocument: mocks.storeDocument
  };
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.VECTOR_EMBED_BATCH_DELAY_MS;
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
    mocks.storeDocument.mockResolvedValueOnce({ attempted: 3, indexed: 3, error: undefined });

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
        acceptance_datetime: ref.acceptanceDateTime
      }),
      "local"
    );
  });

  it("returns error and does NOT record de-dup on storeDocument failure", async () => {
    const ref = makeRef();
    const fakeHtml = "<p>".concat("Risk text. ".repeat(30)).concat("</p>");

    mocks.politeFetchText.mockResolvedValueOnce(fakeHtml);
    mocks.storeDocument.mockResolvedValueOnce({ attempted: 2, indexed: 0, error: "Voyage 429" });

    const { ingestFiling } = await import("../src/lib/web-sources/sec-filings");
    const result = await ingestFiling("AAPL", ref);

    expect(result.error).toBe("Voyage 429");

    const { hasIngestedAccession } = await import("../src/lib/db");
    expect(hasIngestedAccession(ref.accession, ref.docType)).toBe(false);
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
});

// ── 5. Free-tier 1-filing cap in refreshFilingBodies ─────────────────────────

describe("refreshFilingBodies free-tier cap", () => {
  it("processes at most 1 filing on free tier (VECTOR_EMBED_BATCH_DELAY_MS=21000)", async () => {
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "21000";

    // CIK map: AAPL + MSFT
    mocks.loadCikMap.mockResolvedValue({ "320193": "AAPL", "789019": "MSFT" });

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

    mocks.storeDocument.mockResolvedValue({ attempted: 5, indexed: 5, error: undefined });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL", "MSFT"], Date.now());

    // Free-tier cap: at most 1 filing was ATTEMPTED (ingested or skipped)
    expect(result.attempted).toBeLessThanOrEqual(1);
  });

  it("is a no-op when isFilingIngestDue returns false", async () => {
    // Set a recent lastAttempt stamp so the TTL gate fires
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:sec10k:lastAttempt", new Date().toISOString());

    mocks.loadCikMap.mockResolvedValue({ "320193": "AAPL" });

    const { refreshFilingBodies } = await import("../src/lib/web-sources/sec-filings");
    const result = await refreshFilingBodies(["AAPL"], Date.now());

    expect(result.attempted).toBe(0);
    expect(mocks.loadCikMap).not.toHaveBeenCalled();
  });
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

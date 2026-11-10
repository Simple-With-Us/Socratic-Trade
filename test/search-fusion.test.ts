import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import { retrieveFusedContext, wasDenseRecallDegraded } from "../src/lib/rag/search-fusion";
import { insertDocumentChunkFts } from "../src/lib/db-learning";
import { retrieveContextDetailed } from "../src/lib/vector-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-search-fusion-${randomUUID()}.db`)}`;
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    retrieveContextDetailed: vi.fn()
  };
});

const sentryMetricsMocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  recordEmbedFailure: vi.fn()
}));
vi.mock("../src/lib/sentry-metrics", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ...sentryMetricsMocks };
});

beforeEach(() => {
  sentryMetricsMocks.logError.mockClear();
  sentryMetricsMocks.logWarn.mockClear();
  sentryMetricsMocks.recordEmbedFailure.mockClear();
});

describe("Hybrid Search Fusion and MMR Cosine Filtering (P6)", () => {
  it("keeps FTS rows per occurrence (symbol/accession) when content hashes collide", () => {
    const db = getDb();
    // Identical boilerplate (same content hash) in two filings/symbols must keep BOTH lexical
    // rows — retrieval filters by symbol, so a global content-hash delete would silently make
    // the earlier symbol unreachable through FTS.
    insertDocumentChunkFts("sharedhash", "MSFT", "sec-edgar", "acc-msft", "Boilerplate legal text.");
    insertDocumentChunkFts("sharedhash", "GOOG", "sec-edgar", "acc-goog", "Boilerplate legal text.");
    // Re-inserting the SAME occurrence stays idempotent (no duplicate row).
    insertDocumentChunkFts("sharedhash", "GOOG", "sec-edgar", "acc-goog", "Boilerplate legal text.");

    const rows = db.prepare("SELECT symbol, accession FROM document_chunks_fts WHERE content_hash = 'sharedhash' ORDER BY symbol ASC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe("GOOG");
    expect(rows[1].symbol).toBe("MSFT");
  });

  it("does not call any HTTP embedding endpoint for MMR when no alternative provider is configured", async () => {
    insertDocumentChunkFts(
      "hash-fetch-guard",
      "NVDA",
      "sec-edgar",
      "acc-nvda",
      "NVIDIA data center revenue grew on strong AI accelerator demand."
    );
    vi.mocked(retrieveContextDetailed).mockResolvedValue([]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const results = await retrieveFusedContext("NVIDIA revenue", "NVDA", 2);
      expect(results.length).toBeGreaterThan(0);
      // Voyage-only deployment: the Jaccard fallback must be chosen up front — never by firing
      // the Voyage credential at a SiliconFlow/OpenRouter endpoint and catching the failure.
      const embeddingCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes("siliconflow") || String(url).includes("openrouter")
      );
      expect(embeddingCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ranks lexical FTS matches by bm25 relevance before RRF", async () => {
    insertDocumentChunkFts(
      "hash-bm25-weak",
      "ORCL",
      "sec-edgar",
      "acc-orcl",
      "The company discusses many topics including one mention of dividends among other items entirely unrelated to payouts."
    );
    insertDocumentChunkFts(
      "hash-bm25-strong",
      "ORCL",
      "sec-edgar",
      "acc-orcl",
      "Dividends dividends dividends: quarterly dividends declared and dividends paid."
    );
    vi.mocked(retrieveContextDetailed).mockResolvedValue([]);

    const results = await retrieveFusedContext("dividends", "ORCL", 2);
    expect(results.length).toBe(2);
    // The bm25-stronger document must receive lexical rank 1 (higher RRF score).
    expect(results[0].text).toContain("quarterly dividends declared");
  });

  it("should retrieve, fuse via RRF, and filter via Jaccard MMR fallback", async () => {
    // Populate SQLite FTS table with lexical chunks
    insertDocumentChunkFts(
      "hash1",
      "AAPL",
      "sec-edgar",
      "acc1",
      "Apple released the iPhone 17 with advanced AI features and a new design."
    );
    insertDocumentChunkFts(
      "hash2",
      "AAPL",
      "sec-edgar",
      "acc1",
      "iPhone sales were strong, but Mac sales declined slightly."
    );
    insertDocumentChunkFts(
      "hash3",
      "AAPL",
      "sec-edgar",
      "acc1",
      "Apple's capital expenditures increased due to data center investments."
    );

    // Mock vector search results (returns hash2 and hash4)
    vi.mocked(retrieveContextDetailed).mockResolvedValueOnce([
      {
        id: "vector2",
        text: "iPhone sales were strong, but Mac sales declined slightly.",
        score: 0.9,
        source: "sec-edgar"
      },
      {
        id: "vector4",
        text: "Strong growth in Apple Services offsets minor hardware declines.",
        score: 0.8,
        source: "sec-edgar"
      }
    ]);

    // Query for "iPhone"
    const results = await retrieveFusedContext("iPhone", "AAPL", 3);

    // Should return results containing the keyword or high similarity
    expect(results).toHaveLength(3);

    // Verify RRF scoring merged them and MMR removed duplicates
    const texts = results.map(r => r.text);
    expect(texts).toContain("Apple released the iPhone 17 with advanced AI features and a new design.");
    expect(texts).toContain("iPhone sales were strong, but Mac sales declined slightly.");
    expect(texts).toContain("Strong growth in Apple Services offsets minor hardware declines.");
  });

  // P1 fix (2026-09-07): a query-embed 400/429/connection failure inside retrieveContextDetailed
  // used to come back as an empty vectorResults array indistinguishable from "no semantic match",
  // and the bare `catch (err) { console.warn(...) }` here swallowed a thrown failure the same
  // way. The fused result silently proceeded lexical-only with no signal anywhere. These tests
  // cover the fix: a real failure now (a) still returns lexical-only results rather than crashing
  // the whole hybrid query, (b) marks that result as degraded via wasDenseRecallDegraded, and
  // (c) emits a structured error log + metric instead of a swallowed console.warn.
  describe("dense recall degradation signal (P1 fix)", () => {
    it("marks the result degraded and logs an error when retrieveContextDetailed throws (embed/connection failure)", async () => {
      insertDocumentChunkFts(
        "hash-degrade-throw",
        "TSLA",
        "sec-edgar",
        "acc-tsla",
        "Tesla delivered record vehicle volumes this quarter."
      );
      vi.mocked(retrieveContextDetailed).mockRejectedValueOnce(new Error("fetch failed"));

      const results = await retrieveFusedContext("Tesla deliveries", "TSLA", 2);

      // Lexical-only recall still returns something — this is the deliberate "proceed degraded"
      // choice, not a hard fail, but it must be visibly marked as degraded.
      expect(results.length).toBeGreaterThan(0);
      expect(wasDenseRecallDegraded(results)).toBe(true);
      // The log/metric call is fire-and-forget (a dynamic import + .then, never awaited — see
      // "Observability must not affect trading/RAG control flow" elsewhere in this file), so it
      // lands on a later microtask than the function's own return.
      await vi.waitFor(() => {
        expect(sentryMetricsMocks.logError).toHaveBeenCalledWith(
          "rag.dense_recall_degraded",
          expect.objectContaining({ symbol: "TSLA" })
        );
      });
      expect(sentryMetricsMocks.recordEmbedFailure).toHaveBeenCalledWith("search-fusion", "dense-recall-degraded");
    });

    it("marks the result degraded when retrieveContextDetailed reports lookup_failed via onStatus without throwing", async () => {
      insertDocumentChunkFts(
        "hash-degrade-status",
        "AMD",
        "sec-edgar",
        "acc-amd",
        "AMD reported strong data center GPU demand this quarter."
      );
      vi.mocked(retrieveContextDetailed).mockImplementationOnce(async (_query, _symbol, _limit, _userId, options) => {
        options?.onStatus?.("lookup_failed");
        return [];
      });

      const results = await retrieveFusedContext("AMD GPU demand", "AMD", 2);

      expect(results.length).toBeGreaterThan(0);
      expect(wasDenseRecallDegraded(results)).toBe(true);
      await vi.waitFor(() => {
        expect(sentryMetricsMocks.logError).toHaveBeenCalledWith(
          "rag.dense_recall_degraded",
          expect.objectContaining({ symbol: "AMD", reasons: "lookup_failed" })
        );
      });
    });

    it("does NOT mark a genuinely empty (healthy) dense recall as degraded", async () => {
      insertDocumentChunkFts(
        "hash-no-degrade",
        "IBM",
        "sec-edgar",
        "acc-ibm",
        "IBM discussed mainframe modernization initiatives."
      );
      vi.mocked(retrieveContextDetailed).mockResolvedValueOnce([]);

      const results = await retrieveFusedContext("mainframe modernization", "IBM", 2);

      expect(wasDenseRecallDegraded(results)).toBe(false);
      expect(sentryMetricsMocks.logError).not.toHaveBeenCalled();
    });

    // P2 fix (2026-09-07): budget_skipped is a deliberate skip (caller reached its configured RAG
    // budget), not a provider/lookup failure. It must still mark the result degraded (dense
    // recall genuinely did not run) but must NOT emit the error-level Sentry log or bump
    // embed.failed — a persistently exhausted daily budget would otherwise flood Sentry and
    // falsely inflate provider-failure metrics on every fused retrieval.
    it("marks the result degraded on budget_skipped but does NOT report it as a failure", async () => {
      insertDocumentChunkFts(
        "hash-budget-skip",
        "NVDA",
        "sec-edgar",
        "acc-nvda",
        "NVDA data center revenue guidance discussed."
      );
      vi.mocked(retrieveContextDetailed).mockImplementationOnce(async (_query, _symbol, _limit, _userId, options) => {
        options?.onStatus?.("budget_skipped");
        return [];
      });

      const results = await retrieveFusedContext("NVDA data center", "NVDA", 2);

      expect(results.length).toBeGreaterThan(0);
      expect(wasDenseRecallDegraded(results)).toBe(true);
      expect(sentryMetricsMocks.logError).not.toHaveBeenCalled();
      expect(sentryMetricsMocks.recordEmbedFailure).not.toHaveBeenCalled();
    });
  });
});

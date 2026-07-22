import { describe, expect, it } from "vitest";
import {
  loadFrozenProductionRagGoldenSet,
  runProductionRagEvaluation,
  scoreProductionRagCase,
  type ProductionRagGoldenCase
} from "../scripts/eval/rag-production-eval";
import type { RetrievedChunk } from "../src/lib/vector-db";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const golden: ProductionRagGoldenCase = {
  id: "aapl-earnings-pit",
  query: "What did Apple say about services growth?",
  symbol: "AAPL",
  authoritativeAsOf: "2026-05-01T23:59:59.000Z",
  expectedEvidenceRefs: [{ source: "sec-edgar", accession: "0001", section: "MD&A", ordinal: 7, contentHash: "same", vectorId: "historical-vector-id" }],
  category: "earnings",
  expectedSources: ["sec-edgar"],
  expectedSections: ["MD&A"]
};

const chunks: RetrievedChunk[] = [
  {
    id: "expected", text: "Services revenue grew.", score: 0.9, source: "sec-edgar", section: "MD&A",
    metadata: { acceptance_datetime: "2026-05-01T20:00:00.000Z", content_hash: "same", accession: "0001", chunk_ordinal: 7 }
  },
  {
    id: "duplicate", text: "Services revenue grew.", score: 0.8, source: "sec-edgar", section: "MD&A",
    metadata: { acceptance_datetime: "2026-05-01T20:00:00.000Z", content_hash: "same", accession: "0001", chunk_ordinal: 7 }
  },
  {
    id: "future", text: "Future filing.", score: 0.7, source: "sec-edgar", section: "Risk Factors",
    metadata: { acceptance_datetime: "2026-05-02T00:00:00.000Z" }
  },
  { id: "undated", text: "Legacy chunk.", score: 0.6, source: "legacy" }
];

describe("production RAG evaluator", () => {
  it("scores stable provenance relevance despite a changed vector id, plus PIT/duplicate/coverage receipts", () => {
    const result = scoreProductionRagCase(golden, chunks, "ok", 17, 4);
    expect(result.recallAtK).toBe(1);
    expect(result.reciprocalRank).toBe(1);
    expect(result.ndcgAtK).toBe(1);
    expect(result.pitFutureEvidenceIds).toEqual(["future"]);
    expect(result.undatedEvidenceIds).toEqual(["undated"]);
    expect(result.duplicateRate).toBe(0.25);
    expect(result.expectedSourceCoverage).toBe(1);
    expect(result.expectedSectionCoverage).toBe(1);
    expect(result.diagnosticVectorIdMatches).toEqual([]);
  });

  it("drives the evaluator through an injectable production-shaped retriever without a network call", async () => {
    let tick = 100;
    const report = await runProductionRagEvaluation([golden], {
      now: () => (tick += 25),
      retriever: { retrieve: async (query, symbol, limit, userId, options) => {
        expect(query).toBe(golden.query); expect(symbol).toBe("AAPL"); expect(limit).toBe(2);
        expect(userId).toBe("eval-user"); expect(options).toEqual({ asOf: golden.authoritativeAsOf });
        return { chunks: chunks.slice(0, 2), status: "degraded" };
      } },
      limit: 2, userId: "eval-user",
      usageReceipt: () => ({ calls: 2, tokensIn: 12, tokensOut: 0, batchCount: 2, costEstUsd: 0.001, byOperation: [] })
    });
    expect(report.statusCounts.degraded).toBe(1);
    expect(report.metrics.latencyMs.p50).toBe(25);
    expect(report.usageReceipt?.costEstUsd).toBe(0.001);
  });

  it("refuses an empty golden set instead of producing all-zero metrics", async () => {
    await expect(runProductionRagEvaluation([], { retriever: { retrieve: async () => ({ chunks: [], status: "no_memory" }) } }))
      .rejects.toThrow("empty golden set");
  });

  it("loads frozen case files and rejects a case without an authoritative timestamp", () => {
    const path = join(process.env.TMPDIR!, "rag-production-eval-cases.json");
    writeFileSync(path, JSON.stringify({ cases: [golden] }));
    expect(loadFrozenProductionRagGoldenSet(path)).toEqual([golden]);
    writeFileSync(path, JSON.stringify([{ ...golden, authoritativeAsOf: "not-a-date" }]));
    expect(() => loadFrozenProductionRagGoldenSet(path)).toThrow("authoritativeAsOf");
    writeFileSync(path, JSON.stringify([{ ...golden, expectedEvidenceRefs: [{ vectorId: "legacy-only" }] }]));
    expect(() => loadFrozenProductionRagGoldenSet(path)).toThrow("stable selector");
  });
});

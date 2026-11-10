import { describe, expect, it } from "vitest";
import {
  MAX_PRODUCTION_EVAL_CASES,
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
    expect(result.pitValid).toBe(false);
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
        expect(userId).toBe("eval-user");
        expect(options).toEqual({
          asOf: golden.authoritativeAsOf,
          strictAsOf: true,
          runId: expect.stringMatching(/^rag-eval:/),
          applyDefaultFloors: true
        });
        return { chunks: chunks.slice(0, 2), status: "degraded" };
      } },
      limit: 2, userId: "eval-user",
      usageReceipt: () => ({ calls: 2, tokensIn: 12, tokensOut: 0, batchCount: 2, costEstUsd: 0.001, byOperation: [] })
    });
    expect(report.statusCounts.degraded).toBe(1);
    expect(report.metrics.latencyMs.p50).toBe(25);
    expect(report.metrics.pitValid).toBe(true);
    expect(report.evaluationContract.strictAsOf).toBe(true);
    expect(report.configurationSource).toBe("injected-adapter");
    expect(report.usageReceipt?.costEstUsd).toBe(0.001);
    expect(report.runId).toMatch(/^rag-eval:/);
  });

  it("uses the credentialed local user by default while keeping an isolated run id", async () => {
    const previous = process.env.RAG_EVAL_USER_ID;
    delete process.env.RAG_EVAL_USER_ID;
    try {
      let retrievedUserId: string | undefined;
      const report = await runProductionRagEvaluation([golden], {
        retriever: {
          retrieve: async (_query, _symbol, _limit, userId) => {
            retrievedUserId = userId;
            return { chunks: [], status: "no_memory" };
          }
        }
      });
      expect(retrievedUserId).toBe("local");
      expect(report.userId).toBe("local");
      expect(report.runId).toMatch(/^rag-eval:/);
    } finally {
      if (previous === undefined) delete process.env.RAG_EVAL_USER_ID;
      else process.env.RAG_EVAL_USER_ID = previous;
    }
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
    // vectorId is diagnostic-only and must not be the sole scorer (vacuous match risk).
    writeFileSync(path, JSON.stringify([{ ...golden, expectedEvidenceRefs: [{ vectorId: "stable-vector-id" }] }]));
    expect(() => loadFrozenProductionRagGoldenSet(path)).toThrow("vectorId-only");
    writeFileSync(path, JSON.stringify([{ ...golden, expectedEvidenceRefs: [{ source: "sec-edgar", contentHash: "hash-only" }] }]));
    expect(() => loadFrozenProductionRagGoldenSet(path)).toThrow("contentHash must be paired");
    writeFileSync(path, JSON.stringify([{ ...golden, expectedEvidenceRefs: [{ source: "sec-edgar", section: "MD&A" }] }]));
    expect(() => loadFrozenProductionRagGoldenSet(path)).toThrow("requires accession");
    // contentHash + accession is valid stable provenance.
    writeFileSync(path, JSON.stringify([{ ...golden, expectedEvidenceRefs: [{ accession: "0001", contentHash: "hash-ok" }] }]));
    expect(loadFrozenProductionRagGoldenSet(path)[0]!.expectedEvidenceRefs[0]!.contentHash).toBe("hash-ok");
  });

  it("hard-caps case count and per-query result depth", async () => {
    const cases = Array.from({ length: MAX_PRODUCTION_EVAL_CASES + 1 }, (_, index) => ({
      ...golden,
      id: `case-${index}`
    }));
    await expect(runProductionRagEvaluation(cases, {
      retriever: { retrieve: async () => ({ chunks: [], status: "no_memory" }) }
    })).rejects.toThrow("capped at 100 cases");
    await expect(runProductionRagEvaluation([golden], {
      limit: 101,
      retriever: { retrieve: async () => ({ chunks: [], status: "no_memory" }) }
    })).rejects.toThrow("limit must be an integer from 1 to 100");
  });

  it("uses runtime-resolved model and index receipts instead of caller-supplied labels", async () => {
    const report = await runProductionRagEvaluation([golden], {
      configuration: {
        label: "comparison-a",
        embeddingProvider: "untrusted-label",
        embeddingModel: "untrusted-label",
        rerankProvider: "untrusted-label",
        rerankModel: "untrusted-label"
      },
      retriever: {
        retrieve: async () => ({ chunks: [], status: "no_memory" }),
        runtimeConfiguration: async () => ({
          embeddingProvider: "openrouter",
          embeddingModel: "baai/bge-m3",
          rerankProvider: "siliconflow",
          rerankModel: "Qwen/Qwen3-Reranker-8B",
          rerankAvailable: true,
          pineconeIndexName: "actual-index",
          pineconeCredentialSource: "env",
          embeddingCredentialSource: "env",
          ledgerAuthority: "ledger:v1:test"
        })
      }
    });
    expect(report.configuration).toMatchObject({
      label: "comparison-a",
      embeddingProvider: "openrouter",
      embeddingModel: "baai/bge-m3",
      pineconeIndexName: "actual-index"
    });
    expect(report.configurationSource).toBe("runtime-resolved");
  });
});

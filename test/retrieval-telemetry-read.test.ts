// P1-4 (2026-09-27) — the retrieval stage telemetry needed a READ path.
//
// `rag_retrieval_stage_trace` and `rag_retrieval_quality` are written default-on. Before this change
// the only reference to either event anywhere in the repo was audit-prune.ts, which decides how long
// to KEEP them — so a recall stage that silently returned nothing was invisible in-product, and the
// only symptom was a decision that looked inexplicable.
//
// The aggregation is a PURE function over already-parsed payloads, so it is testable without a
// database, and the route's own guarantees (read-only, admin-gated, row-capped) are asserted against
// the source.

import { describe, expect, it } from "vitest";
import {
  aggregateRetrievalQuality,
  aggregateRetrievalStageTraces,
  type RetrievalQualityPayload,
  type RetrievalTraceSnapshot
} from "../src/lib/rag/retrieval-telemetry-read";

const trace = (overrides: Partial<RetrievalTraceSnapshot> = {}): RetrievalTraceSnapshot => ({
  traceVersion: 1,
  queryHash: "abc123",
  symbol: "AAPL",
  route: "strategy-rag",
  wallDurationMs: 120,
  finalCandidates: 4,
  stages: [
    { stage: "query_embed_cache", ordinal: 0, durationMs: 2, ok: true, cacheHit: true },
    { stage: "dense_query", ordinal: 1, durationMs: 40, ok: true, candidatesIn: 50, candidatesOut: 50 },
    { stage: "score_floor", ordinal: 2, durationMs: 3, ok: true, candidatesIn: 50, candidatesOut: 12, dropped: 38 }
  ],
  ...overrides
});

describe("aggregateRetrievalStageTraces", () => {
  it("rolls stages up across traces, busiest first", () => {
    const report = aggregateRetrievalStageTraces([trace(), trace({ symbol: "MSFT" }), trace({ symbol: "MSFT" })]);
    expect(report.symbols).toHaveLength(2);
    expect(report.symbols[0].symbol).toBe("MSFT"); // 2 traces
    expect(report.symbols[0].traces).toBe(2);
    expect(report.symbols[1].symbol).toBe("AAPL");
    const dense = report.stages.find((stage) => stage.stage === "dense_query");
    expect(dense?.calls).toBe(3);
    expect(dense?.errors).toBe(0);
  });

  it("reports the drop arithmetic — the stage that threw candidates away is identifiable", () => {
    const report = aggregateRetrievalStageTraces([trace()]);
    const floor = report.stages.find((stage) => stage.stage === "score_floor");
    expect(floor?.candidatesIn).toBe(50);
    expect(floor?.candidatesOut).toBe(12);
    expect(floor?.dropped).toBe(38);
    expect(floor?.dropRate).toBe(1); // dropped on every call
  });

  it("dropRate counts CALLS that dropped, so a 1-of-500 drop is not overstated", () => {
    const light = trace({
      stages: [{ stage: "dedupe", durationMs: 1, ok: true, candidatesIn: 500, candidatesOut: 499, dropped: 1 }]
    });
    const heavy = trace({
      stages: [{ stage: "dedupe", durationMs: 1, ok: true, candidatesIn: 10, candidatesOut: 0, dropped: 10 }]
    });
    const report = aggregateRetrievalStageTraces([light, heavy]);
    const dedupe = report.stages.find((stage) => stage.stage === "dedupe");
    // Both dropped, so both count as dropping calls — the magnitude lives in `dropped`, which is
    // what the page shows alongside. The distinction is against a stage that never drops.
    expect(dedupe?.dropRate).toBe(1);
    expect(dedupe?.dropped).toBe(11);
    const never = aggregateRetrievalStageTraces([trace()]).stages.find((stage) => stage.stage === "dedupe");
    expect(never).toBeUndefined();
  });

  it("surfaces error kinds and counts a failed stage, which is the diagnosable case", () => {
    const report = aggregateRetrievalStageTraces([
      trace({
        stages: [
          { stage: "rerank", durationMs: 900, ok: false, errorKind: "TimeoutError", provider: "voyage" },
          { stage: "rerank", durationMs: 850, ok: false, errorKind: "TimeoutError", provider: "voyage" },
          { stage: "rerank", durationMs: 12, ok: true, provider: "voyage" }
        ]
      })
    ]);
    const rerank = report.stages[0];
    expect(rerank.errors).toBe(2);
    expect(rerank.errorKinds).toEqual(["TimeoutError"]);
    expect(rerank.providers).toEqual(["voyage"]);
  });

  it("flags the empty-recall case: a trace that ended with zero candidates", () => {
    const report = aggregateRetrievalStageTraces([
      trace({ finalCandidates: 0 }),
      trace({ finalCandidates: 0 }),
      trace({ finalCandidates: 7 })
    ]);
    const aapl = report.symbols.find((row) => row.symbol === "AAPL");
    expect(aapl?.emptyTraces).toBe(2);
    expect(aapl?.meanFinalCandidates).toBeCloseTo(2.33, 2);
  });

  it("duration stats: mean, p95, and max, over a stable sample", () => {
    const report = aggregateRetrievalStageTraces([
      trace({ stages: [{ stage: "dense_query", durationMs: 10, ok: true }] }),
      trace({ stages: [{ stage: "dense_query", durationMs: 20, ok: true }] }),
      trace({ stages: [{ stage: "dense_query", durationMs: 30, ok: true }] })
    ]);
    const dense = report.stages[0];
    expect(dense.meanDurationMs).toBe(20);
    expect(dense.maxDurationMs).toBe(30);
    expect(dense.p95DurationMs).toBe(30);
  });

  it("MALFORMED payloads are skipped, never thrown on — a diagnostics endpoint that 500s is worse", () => {
    const junk = [
      null,
      undefined,
      "not-an-object",
      { stages: "not-an-array" },
      { stages: [null, "x", {}, { stage: null }] },
      trace()
    ] as unknown as RetrievalTraceSnapshot[];
    const report = aggregateRetrievalStageTraces(junk);
    // The one good trace still made it through.
    expect(report.symbols.map((row) => row.symbol)).toEqual(["AAPL"]);
    expect(report.stages.length).toBeGreaterThan(0);
  });

  it("an empty input returns empty aggregates rather than throwing", () => {
    const report = aggregateRetrievalStageTraces([]);
    expect(report.stages).toEqual([]);
    expect(report.symbols).toEqual([]);
    expect(report.routes).toEqual([]);
  });

  it("caps hostile string dimensions so a malformed payload cannot grow the response", () => {
    const report = aggregateRetrievalStageTraces([
      trace({
        symbol: "X".repeat(500),
        route: "R".repeat(500),
        stages: [{ stage: "S".repeat(500), durationMs: 1, ok: true, errorKind: "E".repeat(500) }]
      })
    ]);
    expect(report.symbols[0].symbol.length).toBeLessThanOrEqual(16);
    expect(report.routes[0].length).toBeLessThanOrEqual(60);
    expect(report.stages[0].stage.length).toBeLessThanOrEqual(40);
    expect(report.stages[0].errorKinds[0].length).toBeLessThanOrEqual(60);
  });
});

describe("aggregateRetrievalQuality", () => {
  const sample = (overrides: Partial<RetrievalQualityPayload> = {}): RetrievalQualityPayload => ({
    queryHash: "h",
    k: 8,
    candidates: 50,
    droppedByMinScore: 10,
    droppedByAsOf: 2,
    hybrid: true,
    rerankAttempted: true,
    rerankRan: true,
    topCosine: 0.8,
    topRelevanceScore: 0.6,
    finalCount: 8,
    ...overrides
  });

  it("summarises the quality distribution and the empty-retrieval rate", () => {
    const report = aggregateRetrievalQuality([sample(), sample({ finalCount: 0 }), sample({ finalCount: 0 })]);
    expect(report.samples).toBe(3);
    expect(report.emptyRate).toBeCloseTo(0.6667, 3);
    expect(report.meanFinalCount).toBeCloseTo(2.67, 2);
    expect(report.hybridSamples).toBe(3);
  });

  it("sums the drop counters and averages the scores", () => {
    const report = aggregateRetrievalQuality([sample(), sample({ droppedByMinScore: 4, droppedByAsOf: 0, topCosine: 0.6 })]);
    expect(report.totalDroppedByMinScore).toBe(14);
    expect(report.totalDroppedByAsOf).toBe(2);
    expect(report.meanTopCosine).toBeCloseTo(0.7, 4);
  });

  it("exposes rerank attempted vs ran, which is a silent-failure mode worth seeing", () => {
    const report = aggregateRetrievalQuality([
      sample({ rerankAttempted: true, rerankRan: true }),
      sample({ rerankAttempted: true, rerankRan: false }),
      sample({ rerankAttempted: false, rerankRan: false })
    ]);
    expect(report.rerankAttempted).toBe(2);
    expect(report.rerankRan).toBe(1);
  });

  it("an empty input is all zeroes with a zero emptyRate, not NaN", () => {
    const report = aggregateRetrievalQuality([]);
    expect(report.samples).toBe(0);
    expect(report.emptyRate).toBe(0);
    expect(report.meanTopCosine).toBe(0);
    expect(Number.isNaN(report.meanFinalCount)).toBe(false);
  });
});

describe("the read path exists and is read-only", () => {
  it("the admin route is admin-gated, dynamic, and performs no writes", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "app/api/admin/retrieval-telemetry/route.ts"), "utf8");
    expect(src).toContain("requireAdmin(request)");
    expect(src).toContain('export const dynamic = "force-dynamic"');
    // Read-only: the single data accessor must be the read, and no mutating db call may appear.
    expect(src).toContain("listAuditByKindsSince");
    for (const forbidden of ["insert", "update", "delete", "setInternalSetting", "audit("]) {
      expect(src).not.toContain(forbidden);
    }
    // The response must be explicit about a capped read, so a partial window is never mistaken
    // for a complete one.
    expect(src).toContain("truncated:");
    expect(src).toContain("noData:");
  });

  it("the admin page and its nav entry exist", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(join(process.cwd(), "app/admin/retrieval-telemetry/page.tsx"))).toBe(true);
    const shell = readFileSync(join(process.cwd(), "app/admin/admin-shell.tsx"), "utf8");
    expect(shell).toContain('href: "/admin/retrieval-telemetry"');
  });
});

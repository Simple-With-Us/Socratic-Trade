import { describe, expect, it } from "vitest";
import {
  aggregateModelStats,
  medianMs,
  normalizeBenchmarkSummaries,
  roleForLatencyStep,
  roleForUsageContext,
  type BenchmarkRoleSummary,
  type ModelRoleStats
} from "../src/lib/model-stats";

function statFor(stats: ModelRoleStats[], model: string, role: "green" | "red"): ModelRoleStats {
  const hit = stats.find((s) => s.model === model && s.role === role);
  expect(hit, `expected stats for ${role} ${model}`).toBeDefined();
  return hit!;
}

const NO_BENCH: BenchmarkRoleSummary[] = [];

describe("role mapping", () => {
  it("maps llm_usage contexts: strategy=green, strategy-bear/red-team=red, others ignored", () => {
    expect(roleForUsageContext("strategy")).toBe("green");
    expect(roleForUsageContext("strategy-bear")).toBe("red");
    expect(roleForUsageContext("red-team")).toBe("red");
    expect(roleForUsageContext("chat")).toBeNull();
    expect(roleForUsageContext(null)).toBeNull();
  });

  it("maps llm_call_latency steps: bull=green, bear=red", () => {
    expect(roleForLatencyStep("bull")).toBe("green");
    expect(roleForLatencyStep("bear")).toBe("red");
    expect(roleForLatencyStep("something-else")).toBeNull();
  });
});

describe("medianMs", () => {
  it("returns null for empty, the middle for odd, the rounded mean of the two middles for even", () => {
    expect(medianMs([])).toBeNull();
    expect(medianMs([5000])).toBe(5000);
    expect(medianMs([9000, 1000, 5000])).toBe(5000);
    expect(medianMs([1000, 2000, 3000, 10000])).toBe(2500);
  });
});

describe("aggregateModelStats — live usage rollup", () => {
  it("rolls llm_usage-shaped rows up per (model, role) with avg cost per call", () => {
    const stats = aggregateModelStats({
      usageRows: [
        // Two green rows for the same model (different keyRef/account groupings upstream).
        { model: "gpt-5.4-mini", context: "strategy", calls: 6, costUsd: 0.12 },
        { model: "gpt-5.4-mini", context: "strategy", calls: 4, costUsd: 0.08 },
        // Red side of the same model comes from BOTH bear and red-team contexts.
        { model: "gpt-5.4-mini", context: "strategy-bear", calls: 3, costUsd: 0.03 },
        { model: "gpt-5.4-mini", context: "red-team", calls: 1, costUsd: 0.01 },
        // Non-strategy contexts never leak into picker stats.
        { model: "gpt-5.4-mini", context: "chat", calls: 100, costUsd: 5 },
        // Model-less legacy rows are skipped.
        { model: null, context: "strategy", calls: 9, costUsd: 9 }
      ],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });

    const green = statFor(stats, "gpt-5.4-mini", "green");
    expect(green.liveCalls).toBe(10);
    expect(green.avgCostUsd).toBeCloseTo(0.02, 6);

    const red = statFor(stats, "gpt-5.4-mini", "red");
    expect(red.liveCalls).toBe(4);
    expect(red.avgCostUsd).toBeCloseTo(0.01, 6);
  });

  it("computes live p50 latency from successful llm_call_latency events only", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [
        { payload: { step: "bull", model: "claude-sonnet-5", durationMs: 9000, ok: true } },
        { payload: { step: "bull", model: "claude-sonnet-5", durationMs: 7000, ok: true } },
        { payload: { step: "bull", model: "claude-sonnet-5", durationMs: 8000, ok: true } },
        // Failures (instant 429s etc.) must not drag the p50 toward zero.
        { payload: { step: "bull", model: "claude-sonnet-5", durationMs: 400, ok: false } },
        // Bear samples land on the red side.
        { payload: { step: "bear", model: "claude-sonnet-5", durationMs: 5000, ok: true } },
        // Malformed payloads are skipped without throwing.
        { payload: null },
        { payload: { step: "bull", model: "claude-sonnet-5", ok: true } }
      ],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });

    const green = statFor(stats, "claude-sonnet-5", "green");
    expect(green.latencySamples).toBe(3);
    expect(green.p50LatencyMs).toBe(8000);

    const red = statFor(stats, "claude-sonnet-5", "red");
    expect(red.latencySamples).toBe(1);
    expect(red.p50LatencyMs).toBe(5000);
  });
});

describe("aggregateModelStats — benchmark fallback", () => {
  it("carries benchmark cost + cold p50 so a model with ZERO live traffic still has numbers", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: [
        { model: "gemini-3.5-flash", role: "green", benchmarkCostUsd: 0.0159, benchmarkColdP50Ms: 27395 },
        { model: "gemini-3.5-flash", role: "red", benchmarkCostUsd: 0.0045, benchmarkColdP50Ms: 10260 }
      ],
      closedLots: []
    });

    const green = statFor(stats, "gemini-3.5-flash", "green");
    expect(green.liveCalls).toBe(0);
    expect(green.avgCostUsd).toBeNull();
    expect(green.p50LatencyMs).toBeNull();
    expect(green.benchmarkCostUsd).toBeCloseTo(0.0159, 6);
    expect(green.benchmarkColdP50Ms).toBe(27395);

    const red = statFor(stats, "gemini-3.5-flash", "red");
    expect(red.benchmarkCostUsd).toBeCloseTo(0.0045, 6);
    expect(red.benchmarkColdP50Ms).toBe(10260);
  });

  it("emits rows for models passed via `models` even with no data anywhere", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      models: ["brand-new-model"]
    });
    const s = statFor(stats, "brand-new-model", "green");
    expect(s.liveCalls).toBe(0);
    expect(s.benchmarkCostUsd).toBeNull();
    expect(s.closedTrades).toBe(0);
    expect(s.perf).toBeNull();
  });
});

describe("aggregateModelStats — performance gating", () => {
  const lots = (entryModel: string, reviewedByModel: string | undefined, wins: number, losses: number) => [
    ...Array.from({ length: wins }, () => ({ entryModel, reviewedByModel, pnl: 50, returnPct: 2 })),
    ...Array.from({ length: losses }, () => ({ entryModel, reviewedByModel, pnl: -25, returnPct: -1 }))
  ];

  it("always reports closedTrades, and includes perf whenever closedTrades >= 1 (UI applies thresholds)", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: lots("gpt-5.4-mini", "claude-sonnet-5", 3, 1)
    });
    const green = statFor(stats, "gpt-5.4-mini", "green");
    expect(green.closedTrades).toBe(4);
    expect(green.perf).not.toBeNull();
    expect(green.perf!.closedTrades).toBe(4);
    expect(green.perf!.winRate).toBe(75);
    expect(green.perf!.avgPnlPct).toBeCloseTo(1.25, 2);
    expect(green.perf!.totalPnlUsd).toBeCloseTo(125, 2);
  });

  it("reports zero closed trades + null perf for a model with no attributed lots", () => {
    const stats = aggregateModelStats({
      usageRows: [{ model: "grok-4.3", context: "strategy", calls: 2, costUsd: 0.02 }],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });
    const green = statFor(stats, "grok-4.3", "green");
    expect(green.closedTrades).toBe(0);
    expect(green.perf).toBeNull();
  });

  it("symmetrically attributes closed-trade perf to the red role (reviewer)", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: lots("gpt-5.4-mini", "claude-sonnet-5", 30, 30)
    });
    const red = statFor(stats, "claude-sonnet-5", "red");
    expect(red.closedTrades).toBe(60);
    expect(red.perf).not.toBeNull();
    expect(red.perf!.closedTrades).toBe(60);
    expect(red.perf!.winRate).toBe(50);
  });

  it("ignores lots without an entry model (pre-attribution history)", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [{ pnl: 10, returnPct: 1 }, ...lots("gpt-5.4-mini", undefined, 1, 0)],
      models: []
    });
    const green = statFor(stats, "gpt-5.4-mini", "green");
    expect(green.closedTrades).toBe(1);
  });
});

describe("normalizeBenchmarkSummaries", () => {
  it("prefers cold p50 (falls back to overall p50) and avg est cost (falls back cold→warm)", () => {
    const rows = normalizeBenchmarkSummaries([
      { model: "a", role: "green", coldP50LatencyMs: 1000, p50LatencyMs: 2000, avgEstCostUsd: 0.01, coldAvgCostUsd: 0.02 },
      // No cold sample recorded → overall p50 stands in; no avg → cold cost stands in.
      { model: "b", role: "red", p50LatencyMs: 3000, coldAvgCostUsd: 0.03 },
      { model: "c", role: "green", warmAvgCostUsd: 0.04 }
    ]);
    expect(rows).toEqual([
      { model: "a", role: "green", benchmarkCostUsd: 0.01, benchmarkColdP50Ms: 1000 },
      { model: "b", role: "red", benchmarkCostUsd: 0.03, benchmarkColdP50Ms: 3000 },
      { model: "c", role: "green", benchmarkCostUsd: 0.04 }
    ]);
  });

  it("drops all-error rows (no numbers at all) and malformed roles", () => {
    const rows = normalizeBenchmarkSummaries([
      { model: "mistral-small-2603", role: "green" }, // 3/3 http errors in the real file
      { model: "x", role: "purple", p50LatencyMs: 1 },
      { role: "green", p50LatencyMs: 1 }
    ]);
    expect(rows).toEqual([]);
  });
});

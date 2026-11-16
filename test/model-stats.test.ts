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

function statFor(stats: ModelRoleStats[], model: string, role: "green" | "red" | "strategist"): ModelRoleStats {
  const hit = stats.find((s) => s.model === model && s.role === role);
  expect(hit, `expected stats for ${role} ${model}`).toBeDefined();
  return hit!;
}

const NO_BENCH: BenchmarkRoleSummary[] = [];

describe("role mapping", () => {
  it("maps llm_usage contexts: strategy=green, strategy-bear/red-team=red, strategy-tuning=strategist, others ignored", () => {
    expect(roleForUsageContext("strategy")).toBe("green");
    expect(roleForUsageContext("strategy-bear")).toBe("red");
    expect(roleForUsageContext("red-team")).toBe("red");
    expect(roleForUsageContext("strategy-tuning")).toBe("strategist");
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

    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.liveCalls).toBe(10);
    expect(green.avgCostUsd).toBeCloseTo(0.02, 6);

    const red = statFor(stats, "gpt-mini-latest", "red");
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

    const green = statFor(stats, "claude-sonnet-latest", "green");
    expect(green.latencySamples).toBe(3);
    expect(green.p50LatencyMs).toBe(8000);

    const red = statFor(stats, "claude-sonnet-latest", "red");
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

    const green = statFor(stats, "gemini-flash-latest", "green");
    expect(green.liveCalls).toBe(0);
    expect(green.avgCostUsd).toBeNull();
    expect(green.p50LatencyMs).toBeNull();
    expect(green.benchmarkCostUsd).toBeCloseTo(0.0159, 6);
    expect(green.benchmarkColdP50Ms).toBe(27395);

    const red = statFor(stats, "gemini-flash-latest", "red");
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

describe("aggregateModelStats — strategist (AI review / strategy-tune) rollup", () => {
  it("rolls 'strategy-tuning' usage rows up into a strategist row with cost/call, call count, and TOTAL cost", () => {
    const stats = aggregateModelStats({
      usageRows: [
        { model: "gpt-5.4-mini", context: "strategy-tuning", calls: 3, costUsd: 0.09 },
        { model: "gpt-5.4-mini", context: "strategy-tuning", calls: 2, costUsd: 0.06 },
        // Green/red usage for the SAME model must never leak into its strategist row.
        { model: "gpt-5.4-mini", context: "strategy", calls: 10, costUsd: 1 },
        { model: "gpt-5.4-mini", context: "strategy-bear", calls: 10, costUsd: 1 }
      ],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });

    const strategist = statFor(stats, "gpt-mini-latest", "strategist");
    expect(strategist.liveCalls).toBe(5);
    expect(strategist.avgCostUsd).toBeCloseTo(0.03, 6);
    expect(strategist.totalCostUsd).toBeCloseTo(0.15, 6);
    // No latency, benchmark, perf, or reviewerPerf concept for the strategist role.
    expect(strategist.p50LatencyMs).toBeNull();
    expect(strategist.latencySamples).toBe(0);
    expect(strategist.benchmarkCostUsd).toBeNull();
    expect(strategist.benchmarkColdP50Ms).toBeNull();
    expect(strategist.closedTrades).toBe(0);
    expect(strategist.perf).toBeNull();
    expect(strategist.reviewerPerf).toBeNull();

    // Green/red rows for the same model are unaffected by the strategist usage.
    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.liveCalls).toBe(10);
    const red = statFor(stats, "gpt-mini-latest", "red");
    expect(red.liveCalls).toBe(10);
  });

  it("reports zero calls and null cost for a strategist row with no strategy-tuning usage", () => {
    const stats = aggregateModelStats({
      usageRows: [{ model: "xai/grok-4.3", context: "strategy", calls: 2, costUsd: 0.02 }],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });
    const strategist = statFor(stats, "grok-latest", "strategist");
    expect(strategist.liveCalls).toBe(0);
    expect(strategist.avgCostUsd).toBeNull();
    expect(strategist.totalCostUsd).toBeNull();
  });

  it("never attributes green/red closed-lot or veto data to the strategist role", () => {
    const stats = aggregateModelStats({
      usageRows: [{ model: "claude-sonnet-5", context: "strategy-tuning", calls: 1, costUsd: 0.01 }],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [{ entryModel: "claude-sonnet-5", reviewedByModel: "claude-sonnet-5", pnl: 100, returnPct: 4 }],
      reviewerPerfByModel: [
        { model: "claude-sonnet-5", maturedVetoes: 42, vetoValueAddRate: 61.9, survivorRiskHitRate: 38.1, avgReturnPct: -1.87 }
      ]
    });
    const strategist = statFor(stats, "claude-sonnet-latest", "strategist");
    expect(strategist.closedTrades).toBe(0);
    expect(strategist.perf).toBeNull();
    expect(strategist.reviewerPerf).toBeNull();
  });
});

describe("aggregateModelStats — performance gating", () => {
  const lots = (model: string, wins: number, losses: number) => [
    ...Array.from({ length: wins }, () => ({ entryModel: model, pnl: 50, returnPct: 2 })),
    ...Array.from({ length: losses }, () => ({ entryModel: model, pnl: -25, returnPct: -1 }))
  ];

  it("always reports closedTrades, and includes perf whenever closedTrades >= 1 (UI applies thresholds)", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: lots("gpt-5.4-mini", 3, 1)
    });
    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.closedTrades).toBe(4);
    expect(green.perf).not.toBeNull();
    expect(green.perf!.closedTrades).toBe(4);
    expect(green.perf!.winRate).toBe(75);
    expect(green.perf!.avgPnlPct).toBeCloseTo(1.25, 2);
    expect(green.perf!.totalPnlUsd).toBeCloseTo(125, 2);
  });

  it("reports zero closed trades + null perf for a model with no attributed lots", () => {
    const stats = aggregateModelStats({
      usageRows: [{ model: "xai/grok-4.3", context: "strategy", calls: 2, costUsd: 0.02 }],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });
    const green = statFor(stats, "grok-latest", "green");
    expect(green.closedTrades).toBe(0);
    expect(green.perf).toBeNull();
  });

  it("only attributes entry-model lots to the green role (proposer)", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: lots("gpt-5.4-mini", 30, 30)
    });
    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.closedTrades).toBe(60);
    expect(green.perf).not.toBeNull();

    const red = statFor(stats, "gpt-mini-latest", "red");
    expect(red.closedTrades).toBe(0);
    expect(red.perf).toBeNull();
  });

  it("attributes reviewed-by-model lots to the red role (reviewer) when present", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [
        { reviewedByModel: "claude-sonnet-5", pnl: 100, returnPct: 4 },
        { reviewedByModel: "claude-sonnet-5", pnl: -50, returnPct: -2 }
      ]
    });
    const red = statFor(stats, "claude-sonnet-latest", "red");
    expect(red.closedTrades).toBe(2);
    expect(red.perf).not.toBeNull();
    expect(red.perf!.closedTrades).toBe(2);
    expect(red.perf!.winRate).toBe(50);
    expect(red.perf!.avgPnlPct).toBe(1);
    expect(red.perf!.totalPnlUsd).toBe(50);

    const green = statFor(stats, "claude-sonnet-latest", "green");
    expect(green.closedTrades).toBe(0);
    expect(green.perf).toBeNull();
  });

  it("ignores lots without an entry model (pre-attribution history)", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [{ pnl: 10, returnPct: 1 }, ...lots("gpt-5.4-mini", 1, 0)],
      models: []
    });
    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.closedTrades).toBe(1);
  });
});

describe("aggregateModelStats — reviewer veto value-add", () => {
  // Shaped exactly like getRedTeamEfficacy(userId).byModel, including the "unattributed" bucket.
  const reviewerRows = [
    { model: "claude-sonnet-5", maturedVetoes: 42, vetoValueAddRate: 61.9, survivorRiskHitRate: 38.1, avgReturnPct: -1.87 },
    { model: "unattributed", maturedVetoes: 99, vetoValueAddRate: 50, survivorRiskHitRate: 50, avgReturnPct: 0 }
  ];

  it("populates reviewerPerf on the matching RED row and leaves it null on the GREEN row", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      reviewerPerfByModel: reviewerRows
    });

    const red = statFor(stats, "claude-sonnet-latest", "red");
    expect(red.reviewerPerf).toEqual({
      maturedVetoes: 42,
      vetoValueAddRate: 61.9,
      survivorRiskHitRate: 38.1,
      avgReturnPct: -1.87
    });

    // Realized-P&L perf and reviewerPerf never cross roles: the GREEN row stays null.
    const green = statFor(stats, "claude-sonnet-latest", "green");
    expect(green.reviewerPerf).toBeNull();
  });

  it("excludes the 'unattributed' bucket entirely — it never becomes a model row", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      reviewerPerfByModel: reviewerRows
    });
    expect(stats.some((s) => s.model === "unattributed")).toBe(false);
  });

  it("merges reviewer perf rows that canonicalize onto the same family", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      reviewerPerfByModel: [
        { model: "google/gemini-3.7-flash", maturedVetoes: 10, vetoValueAddRate: 60, survivorRiskHitRate: 40, avgReturnPct: -2 },
        { model: "gemini-flash-latest", maturedVetoes: 10, vetoValueAddRate: 40, survivorRiskHitRate: 60, avgReturnPct: 2 }
      ]
    });
    expect(statFor(stats, "gemini-flash-latest", "red").reviewerPerf).toEqual({
      maturedVetoes: 20,
      vetoValueAddRate: 50,
      survivorRiskHitRate: 50,
      avgReturnPct: 0
    });
    expect(stats.some((s) => s.model === "google/gemini-3.7-flash")).toBe(false);
  });

  it("leaves reviewerPerf null on RED rows without matching veto data (and defaults to null with no input)", () => {
    const stats = aggregateModelStats({
      usageRows: [{ model: "xai/grok-4.3", context: "strategy", calls: 1, costUsd: 0.01 }],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      reviewerPerfByModel: [{ model: "claude-sonnet-5", maturedVetoes: 30, vetoValueAddRate: 60, survivorRiskHitRate: 40, avgReturnPct: -2 }]
    });
    // grok-4.3 has usage but no reviewer data → its RED row is null.
    expect(statFor(stats, "grok-latest", "red").reviewerPerf).toBeNull();
    // A model with reviewer data still has a null RED row default when reviewerPerfByModel is omitted.
    const noReviewerInput = aggregateModelStats({ usageRows: [], latencyEvents: [], benchmarkSummaries: NO_BENCH, closedLots: [], models: ["claude-sonnet-5"] });
    expect(statFor(noReviewerInput, "claude-sonnet-latest", "red").reviewerPerf).toBeNull();
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
      { model: "mistral-small-latest", role: "green" }, // 3/3 http errors in the real file
      { model: "x", role: "purple", p50LatencyMs: 1 },
      { role: "green", p50LatencyMs: 1 }
    ]);
    expect(rows).toEqual([]);
  });

  it("safely concatenates a stale all-error summary with a later real re-benchmark for the SAME (model, role) — no duplicate, no overwrite ambiguity", () => {
    // Mirrors app/api/llm-usage/model-stats/route.ts: it concatenates the 2026-07-08 full sweep
    // (Mistral rows all-error) with the 2026-07-10 Mistral re-benchmark (real numbers) before
    // normalizing. The stale entry carries no numbers so it's dropped regardless of position —
    // only the real entry survives.
    const rows = normalizeBenchmarkSummaries([
      { model: "mistral-medium-3-5", role: "green" }, // stale: 2026-07-08, 0/3 http errors
      { model: "mistral-medium-3-5", role: "green", p50LatencyMs: 1261, avgEstCostUsd: 0.0117 } // real: 2026-07-10
    ]);
    expect(rows).toEqual([{ model: "mistral-medium-latest", role: "green", benchmarkCostUsd: 0.0117, benchmarkColdP50Ms: 1261 }]);
  });
});

describe("aggregateModelStats — token aggregation & predecessor lineage", () => {
  it("aggregates promptTokens, completionTokens, totalTokens, and computes avgTokensPerCall", () => {
    const stats = aggregateModelStats({
      usageRows: [
        {
          model: "gpt-5.4-mini",
          context: "strategy",
          calls: 4,
          costUsd: 0.08,
          promptTokens: 4000,
          completionTokens: 800,
          totalTokens: 4800
        },
        {
          model: "gpt-5.4-mini",
          context: "strategy",
          calls: 6,
          costUsd: 0.12,
          promptTokens: 6000,
          completionTokens: 1200,
          totalTokens: 7200
        }
      ],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });

    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.liveCalls).toBe(10);
    expect(green.promptTokens).toBe(10000);
    expect(green.completionTokens).toBe(2000);
    expect(green.totalTokens).toBe(12000);
    expect(green.avgTokensPerCall).toBe(1200);
  });

  it("excludes canonical self-IDs from lineage roll-forward (no double-count)", () => {
    // gemini-3.8-flash canonicalizes to gemini-flash-latest. If we treated it as a predecessor
    // of gemini-flash-latest, combining lots would double-count the same 10 trades into 20.
    const lots = Array.from({ length: 10 }, () => ({
      entryModel: "gemini-flash-latest",
      reviewedByModel: null,
      pnl: 10,
      returnPct: 1
    }));
    const stats = aggregateModelStats({
      usageRows: [
        {
          model: "gemini-flash-latest",
          context: "strategy",
          calls: 2,
          costUsd: 0.02,
          promptTokens: 200,
          completionTokens: 40,
          totalTokens: 240
        }
      ],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: lots,
      models: ["gemini-flash-latest"]
    });
    const flash = statFor(stats, "gemini-flash-latest", "green");
    expect(flash.closedTrades).toBe(10);
    expect(flash.perf?.closedTrades).toBe(10);
    expect(flash.liveCalls).toBe(2);
    expect(flash.perfInheritedFrom).toBeNull();
    // Cost stay direct (no true predecessor with samples to combine against self).
    expect(flash.costInheritedFrom).toBeNull();
  });

  it("excludes missing token telemetry from avgTokensPerCall denominator", () => {
    const stats = aggregateModelStats({
      usageRows: [
        {
          model: "gpt-5.4-mini",
          context: "strategy",
          calls: 5,
          costUsd: 0.05,
          // 3 of 5 calls reported tokens
          callsWithTokens: 3,
          promptTokens: 3000,
          completionTokens: 600,
          totalTokens: 3600
        }
      ],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: []
    });
    const green = statFor(stats, "gpt-mini-latest", "green");
    expect(green.liveCalls).toBe(5);
    expect(green.callsWithTokens).toBe(3);
    expect(green.avgTokensPerCall).toBe(1200); // 3600/3, not 3600/5
  });
});

describe("aggregateModelStats — same-class predecessor estimates (ST-4589)", () => {
  const usage = (model: string, calls: number, costUsd: number, context = "strategy") => ({
    model,
    context,
    calls,
    costUsd,
    promptTokens: calls * 1000,
    completionTokens: calls * 200,
    totalTokens: calls * 1200
  });

  it("keeps the model's own n and sums strictly own; the predecessor figure is a separate estimate", () => {
    // gpt-5.6-sol lists gpt-5.5 (same class chain, not in the catalog) as a predecessor.
    const stats = aggregateModelStats({
      usageRows: [usage("gpt-5.5", 10, 1.0), usage("gpt-5.6-sol", 2, 0.4)],
      latencyEvents: [
        { payload: { step: "bull", model: "gpt-5.5", durationMs: 4000, ok: true } },
        { payload: { step: "bull", model: "gpt-5.5", durationMs: 4200, ok: true } },
        { payload: { step: "bull", model: "gpt-5.5", durationMs: 4400, ok: true } }
      ],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      models: ["gpt-5.6-sol"]
    });
    const sol = statFor(stats, "gpt-5.6-sol", "green");
    expect(sol.liveCalls).toBe(2);
    expect(sol.totalCostUsd).toBeCloseTo(0.4, 6);
    expect(sol.avgCostUsd).toBeCloseTo(0.2, 6);
    expect(sol.totalTokens).toBe(2400);
    expect(sol.latencySamples).toBe(0);
    expect(sol.p50LatencyMs).toBeNull();
    // The estimate is carried separately and labelled with its own n.
    expect(sol.isInherited).toBe(true);
    expect(sol.inheritedFrom).toBe("gpt-5.5");
    expect(sol.costInheritedFrom).toBe("gpt-5.5");
    expect(sol.inheritedCalls).toBe(10);
    expect(sol.inheritedCostPerCall).toBeCloseTo(0.1, 6);
    expect(sol.inheritedAvgTokensPerCall).toBe(1200);
    expect(sol.inheritedPromptTokensPerCall).toBe(1000);
    expect(sol.inheritedCompletionTokensPerCall).toBe(200);
    expect(sol.latencyInheritedFrom).toBe("gpt-5.5");
    expect(sol.inheritedP50LatencyMs).toBe(4200);
    expect(sol.inheritedLatencySamples).toBe(3);
  });

  it("does not estimate once the model has enough own live calls", () => {
    const stats = aggregateModelStats({
      usageRows: [usage("gpt-5.5", 10, 1.0), usage("gpt-5.6-sol", 5, 1.5)],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      models: ["gpt-5.6-sol"]
    });
    const sol = statFor(stats, "gpt-5.6-sol", "green");
    expect(sol.liveCalls).toBe(5);
    expect(sol.costInheritedFrom).toBeNull();
    expect(sol.inheritedCalls).toBe(0);
    expect(sol.inheritedCostPerCall).toBeNull();
  });

  it("keeps realized performance and veto efficacy own-only, exposing the predecessor's as a labelled estimate", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [
        ...Array.from({ length: 25 }, () => ({ entryModel: "gpt-5.5", reviewedByModel: null, pnl: 100, returnPct: 5 })),
        { entryModel: "gpt-5.6-sol", reviewedByModel: null, pnl: 50, returnPct: 2 }
      ],
      reviewerPerfByModel: [
        { model: "gpt-5.5", maturedVetoes: 35, vetoValueAddRate: 70, survivorRiskHitRate: 30, avgReturnPct: -4.5 },
        { model: "gpt-5.6-sol", maturedVetoes: 4, vetoValueAddRate: 50, survivorRiskHitRate: 50, avgReturnPct: 0 }
      ],
      models: ["gpt-5.6-sol"]
    });
    const green = statFor(stats, "gpt-5.6-sol", "green");
    expect(green.closedTrades).toBe(1);
    expect(green.perf?.closedTrades).toBe(1);
    expect(green.perfInheritedFrom).toBe("gpt-5.5");
    expect(green.inheritedClosedTrades).toBe(25);
    expect(green.inheritedPerf).toMatchObject({ closedTrades: 25, winRate: 100, avgPnlPct: 5 });

    const red = statFor(stats, "gpt-5.6-sol", "red");
    expect(red.reviewerPerf?.maturedVetoes).toBe(4);
    expect(red.vetoInheritedFrom).toBe("gpt-5.5");
    expect(red.inheritedReviewerPerf).toMatchObject({ maturedVetoes: 35, vetoValueAddRate: 70, avgReturnPct: -4.5 });
  });

  it("never rolls terra into sol or astra (terra is its own class)", () => {
    const stats = aggregateModelStats({
      usageRows: [usage("gpt-5.6-terra", 20, 2.0), usage("gpt-5.6-terra", 6, 0.6, "red-team")],
      latencyEvents: [{ payload: { step: "bull", model: "gpt-5.6-terra", durationMs: 3000, ok: true } }],
      benchmarkSummaries: NO_BENCH,
      closedLots: Array.from({ length: 30 }, () => ({ entryModel: "gpt-5.6-terra", reviewedByModel: "gpt-5.6-terra", pnl: 10, returnPct: 3 })),
      reviewerPerfByModel: [{ model: "gpt-5.6-terra", maturedVetoes: 40, vetoValueAddRate: 60, survivorRiskHitRate: 40, avgReturnPct: -2 }],
      models: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-astra-pro", "gpt-5.6-luna"]
    });
    for (const model of ["gpt-5.6-sol", "gpt-6-astra", "gpt-6-astra-pro", "gpt-5.6-luna"]) {
      for (const role of ["green", "red"] as const) {
        const row = statFor(stats, model, role);
        expect(row.liveCalls, `${role} ${model}`).toBe(0);
        expect(row.closedTrades, `${role} ${model}`).toBe(0);
        expect(row.costInheritedFrom, `${role} ${model}`).toBeNull();
        expect(row.perfInheritedFrom, `${role} ${model}`).toBeNull();
        expect(row.vetoInheritedFrom, `${role} ${model}`).toBeNull();
        expect(row.inheritedFrom, `${role} ${model}`).toBeNull();
      }
    }
    // Terra itself keeps its own numbers.
    expect(statFor(stats, "gpt-5.6-terra", "green").liveCalls).toBe(20);
  });

  it("astra-pro estimates from astra's OWN numbers; astra (no predecessors) never inherits", () => {
    const stats = aggregateModelStats({
      usageRows: [usage("gpt-6-astra", 8, 0.8)],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      models: ["gpt-6-astra", "gpt-6-astra-pro"]
    });
    const astra = statFor(stats, "gpt-6-astra", "green");
    expect(astra.liveCalls).toBe(8);
    expect(astra.isInherited).toBe(false);
    const pro = statFor(stats, "gpt-6-astra-pro", "green");
    expect(pro.liveCalls).toBe(0);
    expect(pro.avgCostUsd).toBeNull();
    expect(pro.costInheritedFrom).toBe("gpt-6-astra");
    expect(pro.inheritedCalls).toBe(8);
    expect(pro.inheritedCostPerCall).toBeCloseTo(0.1, 6);
  });

  it("drops every llama model id from the output", () => {
    const stats = aggregateModelStats({
      usageRows: [usage("llama-4-scout", 9, 0.9), usage("meta-llama/llama-3.3-70b-instruct", 3, 0.3)],
      latencyEvents: [{ payload: { step: "bull", model: "llama-4-maverick", durationMs: 1000, ok: true } }],
      benchmarkSummaries: [{ model: "llama-4-scout", role: "green", benchmarkCostUsd: 0.01 }],
      closedLots: [{ entryModel: "llama-4-maverick", reviewedByModel: null, pnl: 1, returnPct: 1 }],
      models: ["muse-spark-1.3", "muse-glimmer-30b"]
    });
    expect(stats.some((s) => /llama/i.test(s.model))).toBe(false);
    for (const model of ["muse-spark-1.3", "muse-glimmer-30b"]) {
      expect(statFor(stats, model, "green").isInherited, model).toBe(false);
    }
  });

  it("labels each row with its model class", () => {
    const stats = aggregateModelStats({
      usageRows: [],
      latencyEvents: [],
      benchmarkSummaries: NO_BENCH,
      closedLots: [],
      models: ["gpt-6-astra", "claude-opus-latest", "muse-spark-1.3", "gpt-5.6-terra"]
    });
    expect(statFor(stats, "gpt-6-astra", "green")).toMatchObject({ modelClass: "openai-astra", modelClassLabel: "Astra" });
    expect(statFor(stats, "claude-opus-latest", "green")).toMatchObject({ modelClass: "anthropic-opus", modelClassLabel: "Opus" });
    expect(statFor(stats, "muse-spark-1.3", "green")).toMatchObject({ modelClass: "meta-spark", modelClassLabel: "Spark" });
    expect(statFor(stats, "gpt-5.6-terra", "green")).toMatchObject({ modelClass: null, modelClassLabel: null });
  });
});

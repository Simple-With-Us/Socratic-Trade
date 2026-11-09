import { describe, expect, it } from "vitest";
import {
  aggregateUsageByModel,
  canonicalModelId,
  displayModelName,
  type UsageLike
} from "../app/admin/llm-usage/model-merge";

function row(partial: Partial<UsageLike> & { provider: string; model: string | null }): UsageLike {
  return {
    calls: 1,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    ...partial
  };
}

describe("canonicalModelId (shared with src/lib/model-stats.ts via src/lib/model-identity.ts)", () => {
  it("collapses the OpenRouter vendor prefix and specific versions onto the canonical latest model class id", () => {
    // The whole point: a direct Anthropic call, OpenRouter call, and specific versions map to the canonical model class.
    expect(canonicalModelId("claude-sonnet-5")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("openrouter/anthropic/claude-sonnet-5")).toBe("claude-sonnet-latest");
    expect(canonicalModelId("openai/gpt-5.4-mini")).toBe("gpt-mini-latest");
    expect(canonicalModelId("google/gemini-3.7-flash")).toBe("gemini-flash-latest");
    expect(canonicalModelId("claude-opus-4-8")).toBe("claude-opus-latest");
  });

  it("maps null/blank models to '' (legacy rows without model tracking)", () => {
    expect(canonicalModelId(null)).toBe("");
    expect(canonicalModelId("")).toBe("");
    expect(canonicalModelId("   ")).toBe("");
  });

  it("displayModelName is the same bare-name derivation (single shared definition)", () => {
    expect(displayModelName("openrouter/openai/gpt-5.4-mini")).toBe("gpt-mini-latest");
    expect(displayModelName("claude-sonnet-5")).toBe("claude-sonnet-latest");
    expect(displayModelName).toBe(canonicalModelId);
  });
});

describe("aggregateUsageByModel", () => {
  it("merges OpenRouter and direct calls for the same model, preserving a per-provider breakdown", () => {
    // The core behavior the owner asked for: pre-OpenRouter direct stats + new OpenRouter stats
    // for the SAME model, combined into one total, with both routes still visible.
    const rows: UsageLike[] = [
      row({ provider: "anthropic", model: "claude-sonnet-5", calls: 600, totalTokens: 6000, costUsd: 6 }),
      row({ provider: "openrouter", model: "anthropic/claude-sonnet-5", calls: 400, totalTokens: 4000, costUsd: 4 })
    ];
    const [agg] = aggregateUsageByModel(rows);
    expect(agg.canonicalId).toBe("claude-sonnet-latest");
    // Merged total.
    expect(agg.calls).toBe(1000);
    expect(agg.totalTokens).toBe(10_000);
    expect(agg.costUsd).toBe(10);
    // Both routes preserved, sorted by cost desc (direct 6 > openrouter 4).
    expect(agg.providers.map((p) => p.provider)).toEqual(["anthropic", "openrouter"]);
    expect(agg.providers.find((p) => p.provider === "openrouter")!.calls).toBe(400);
    expect(agg.providers.find((p) => p.provider === "anthropic")!.calls).toBe(600);
  });

  it("collapses multiple rows of the same (model, provider) — e.g. different contexts — into one slice", () => {
    const rows: UsageLike[] = [
      row({ provider: "openrouter", model: "openai/gpt-5.4-mini", calls: 3, costUsd: 0.3 }),
      row({ provider: "openrouter", model: "openai/gpt-5.4-mini", calls: 2, costUsd: 0.2 })
    ];
    const [agg] = aggregateUsageByModel(rows);
    expect(agg.canonicalId).toBe("gpt-mini-latest");
    expect(agg.calls).toBe(5);
    expect(agg.providers).toHaveLength(1);
    expect(agg.providers[0]!.calls).toBe(5);
  });

  it("keeps distinct models separate and orders aggregates by cost desc", () => {
    const rows: UsageLike[] = [
      row({ provider: "anthropic", model: "claude-sonnet-5", costUsd: 2 }),
      row({ provider: "openai", model: "gpt-5.4-mini", costUsd: 9 })
    ];
    const aggs = aggregateUsageByModel(rows);
    expect(aggs.map((a) => a.canonicalId)).toEqual(["gpt-mini-latest", "claude-sonnet-latest"]);
  });

  it("merges Gemini Flash version slugs into one family row", () => {
    const rows: UsageLike[] = [
      row({ provider: "openrouter", model: "google/gemini-3.7-flash", calls: 3, costUsd: 0.3 }),
      row({ provider: "openrouter", model: "gemini-flash-latest", calls: 2, costUsd: 0.2 }),
      row({ provider: "gemini", model: "gemini-3.5-flash", calls: 1, costUsd: 0.1 })
    ];
    const [agg] = aggregateUsageByModel(rows);
    expect(agg.canonicalId).toBe("gemini-flash-latest");
    expect(agg.calls).toBe(6);
    expect(agg.costUsd).toBeCloseTo(0.6);
  });

  it("does not mutate the input rows (read-only aggregation)", () => {
    const rows: UsageLike[] = [row({ provider: "anthropic", model: "claude-sonnet-5", calls: 5, costUsd: 1 })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    aggregateUsageByModel(rows);
    expect(rows).toEqual(snapshot);
  });
});

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
  it("collapses the OpenRouter vendor prefix onto the bare direct-call id", () => {
    // The whole point: a direct Anthropic call and an OpenRouter-routed one must share a key.
    expect(canonicalModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(canonicalModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(canonicalModelId("openrouter/anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(canonicalModelId("openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("preserves original casing (catalog/benchmark keys are case-sensitive)", () => {
    expect(canonicalModelId("anthropic/Claude-Sonnet-5")).toBe("Claude-Sonnet-5");
    expect(canonicalModelId("GPT-5.4-Mini")).toBe("GPT-5.4-Mini");
  });

  it("maps null/blank models to '' (legacy rows without model tracking)", () => {
    expect(canonicalModelId(null)).toBe("");
    expect(canonicalModelId("")).toBe("");
    expect(canonicalModelId("   ")).toBe("");
  });

  it("displayModelName is the same bare-name derivation (single shared definition)", () => {
    expect(displayModelName("openrouter/openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(displayModelName("claude-sonnet-5")).toBe("claude-sonnet-5");
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
    expect(agg.canonicalId).toBe("claude-sonnet-5");
    // Merged total.
    expect(agg.calls).toBe(1000);
    expect(agg.totalTokens).toBe(10_000);
    expect(agg.costUsd).toBe(10);
    // Both routes preserved, sorted by cost desc (direct 6 > openrouter 4).
    expect(agg.providers.map((p) => p.provider)).toEqual(["anthropic", "openrouter"]);
    expect(agg.providers.find((p) => p.provider === "openrouter")!.calls).toBe(400);
    expect(agg.providers.find((p) => p.provider === "anthropic")!.calls).toBe(600);
  });

  it("merges rows case-insensitively while preserving the first display casing", () => {
    const rows: UsageLike[] = [
      row({ provider: "anthropic", model: "Claude-Sonnet-5", calls: 1, costUsd: 1 }),
      row({ provider: "openrouter", model: "anthropic/claude-sonnet-5", calls: 2, costUsd: 2 })
    ];

    const [agg] = aggregateUsageByModel(rows);
    expect(agg.canonicalId).toBe("Claude-Sonnet-5");
    expect(agg.displayName).toBe("Claude-Sonnet-5");
    expect(agg.calls).toBe(3);
    expect(agg.providers.map((p) => p.provider)).toEqual(["openrouter", "anthropic"]);
  });

  it("collapses multiple rows of the same (model, provider) — e.g. different contexts — into one slice", () => {
    const rows: UsageLike[] = [
      row({ provider: "openrouter", model: "openai/gpt-5.4-mini", calls: 3, costUsd: 0.3 }),
      row({ provider: "openrouter", model: "openai/gpt-5.4-mini", calls: 2, costUsd: 0.2 })
    ];
    const [agg] = aggregateUsageByModel(rows);
    expect(agg.canonicalId).toBe("gpt-5.4-mini");
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
    expect(aggs.map((a) => a.canonicalId)).toEqual(["gpt-5.4-mini", "claude-sonnet-5"]);
  });

  it("does not mutate the input rows (read-only aggregation)", () => {
    const rows: UsageLike[] = [row({ provider: "anthropic", model: "claude-sonnet-5", calls: 5, costUsd: 1 })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    aggregateUsageByModel(rows);
    expect(rows).toEqual(snapshot);
  });
});

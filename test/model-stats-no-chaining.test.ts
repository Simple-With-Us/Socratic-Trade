// ST-4589: estimates come from a predecessor's OWN numbers only — never from a predecessor that
// itself carries an estimate. The real catalog has no three-link chain, so the predecessor graph
// is faked here: c -> b -> a (a has data, b has none, c has none).
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/llm-model-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm-model-catalog")>();
  const graph: Record<string, string[]> = { "fake-b": ["fake-a"], "fake-c": ["fake-b"] };
  return {
    ...actual,
    getPredecessorModelIds: (model: string | null | undefined) => graph[model ?? ""] ?? actual.getPredecessorModelIds(model)
  };
});

import { aggregateModelStats } from "../src/lib/model-stats";

describe("aggregateModelStats — no chaining", () => {
  it("a successor of a successor does not receive the middle model's inherited estimate", () => {
    const stats = aggregateModelStats({
      usageRows: [{ model: "fake-a", context: "strategy", calls: 12, costUsd: 1.2, promptTokens: 1200, completionTokens: 240, totalTokens: 1440 }],
      latencyEvents: [],
      benchmarkSummaries: [],
      closedLots: Array.from({ length: 25 }, () => ({ entryModel: "fake-a", reviewedByModel: null, pnl: 1, returnPct: 1 })),
      models: ["fake-a", "fake-b", "fake-c"]
    });
    const get = (model: string) => stats.find((s) => s.model === model && s.role === "green")!;
    // b inherits from a's own numbers.
    expect(get("fake-b").costInheritedFrom).toBe("fake-a");
    expect(get("fake-b").inheritedCalls).toBe(12);
    expect(get("fake-b").perfInheritedFrom).toBe("fake-a");
    // c's only predecessor is b, which has NO own data of its own: nothing is passed down.
    const c = get("fake-c");
    expect(c.liveCalls).toBe(0);
    expect(c.isInherited).toBe(false);
    expect(c.costInheritedFrom).toBeNull();
    expect(c.inheritedCalls).toBe(0);
    expect(c.perfInheritedFrom).toBeNull();
    expect(c.inheritedPerf).toBeNull();
  });
});

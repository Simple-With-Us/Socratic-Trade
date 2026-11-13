import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(tmpdir(), `retired-model-price-${randomUUID()}.db`)}`;
const { estimateLlmCostUsd, recordLlmUsage } = await import("../src/lib/llm-usage");
const { getDb } = await import("../src/lib/db");

afterAll(() => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

// Exact base prompt/completion prices, public OpenRouter model list checked 2026-11-13:
// https://openrouter.ai/api/v1/models?limit=500
// These are not cache, long-context, provider override or live-generation assertions.
describe("retired stored-model base prices", () => {
  for (const [model, input, output] of [
    ["gpt-5.6-sol", 4.4, 22],
    ["openai/gpt-5.6-sol", 4.4, 22],
    ["openrouter/openai/gpt-5.6-sol", 4.4, 22],
    ["muse-glimmer-30b", 0.3, 1.2],
    ["meta/muse-glimmer-30b", 0.3, 1.2],
    ["openrouter/meta/muse-glimmer-30b", 0.3, 1.2]
  ] as const) {
    it(`prices ${model} without borrowing another generation's rate`, () => {
      expect(estimateLlmCostUsd(model, 1_000_000, 0)).toBe(input);
      expect(estimateLlmCostUsd(model, 0, 1_000_000)).toBe(output);
    });
  }

  it("keeps newer Sol, historical bare 5.6 and other Muse tiers separate", () => {
    expect(estimateLlmCostUsd("gpt-6.1-sol", 1_000_000, 1_000_000)).toBe(12);
    expect(estimateLlmCostUsd("gpt-5.6", 1_000_000, 1_000_000)).toBe(35);
    expect(estimateLlmCostUsd("muse-spark-1.3", 1_000_000, 1_000_000)).toBe(5.5);
    expect(estimateLlmCostUsd("muse-spark-1.3-contributor", 1_000_000, 1_000_000)).toBeCloseTo(0.3);
    expect(estimateLlmCostUsd("muse-wonder-1.0-contributor", 1_000_000, 1_000_000)).toBeUndefined();
  });

  it.each([0, 0.123])("keeps OpenRouter billed %s ahead of base estimates", (billedCostUsd) => {
    const context = `retired-billed-${randomUUID()}`;
    recordLlmUsage({ userId: "local", provider: "openrouter", model: "openai/gpt-5.6-sol", context, keySource: "user", promptTokens: 1_000_000, completionTokens: 1_000_000, billedCostUsd });
    const row = getDb().prepare("SELECT cost_usd, cost_source FROM llm_usage WHERE context = ?").get(context);
    expect(row).toEqual({ cost_usd: billedCostUsd, cost_source: "billed" });
  });
});

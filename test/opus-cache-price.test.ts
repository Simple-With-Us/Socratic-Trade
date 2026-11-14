import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDatabaseUrl = process.env.DATABASE_URL;
let estimateLlmCostUsd: typeof import("../src/lib/llm-usage").estimateLlmCostUsd;
let extractLlmUsage: typeof import("../src/lib/llm-usage").extractLlmUsage;
let recordLlmUsage: typeof import("../src/lib/llm-usage").recordLlmUsage;
let getDb: typeof import("../src/lib/db").getDb;
beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `opus-cache-price-${randomUUID()}.db`)}`;
  ({ estimateLlmCostUsd, extractLlmUsage, recordLlmUsage } = await import("../src/lib/llm-usage"));
  ({ getDb } = await import("../src/lib/db"));
});
afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// Verified 2026-11-13: https://platform.claude.com/docs/en/models/opus-5-5/overview
// Base $4/$20, cache read $0.20 per million tokens, 5m write $5.
describe("Opus 5.5 cache-read estimate", () => {
  it.each([
    "claude-opus-5-5", "claude-opus-5.5", "claude-opus-latest",
    "anthropic/claude-opus-5-5", "anthropic/claude-opus-5.5", "~anthropic/claude-opus-latest",
    "openrouter/anthropic/claude-opus-5.5", "CLAUDE-OPUS-5-5",
    "openrouter/~anthropic/claude-opus-latest"
  ])("prices one million cache reads at $0.20, not $0.40: %s", (model) => {
    expect(estimateLlmCostUsd(model, 1_000_000, 0, 1_000_000)).toBeCloseTo(0.2, 10);
  });
  it("combines uncached, cached, cache creation and output without double-counting", () => {
    const usage = extractLlmUsage({ usage: { input_tokens: 800, output_tokens: 400, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1200 } });
    expect(usage.promptTokens).toBe(6000);
    expect(estimateLlmCostUsd("claude-opus-5-5", usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens, usage.cacheCreationTokens)).toBeCloseTo((800 * 4 + 4000 * 0.2 + 1200 * 5 + 400 * 20) / 1_000_000, 10);
  });
  it("keeps historical Opus 4.8 cache reads at their existing 0.1 multiplier", () => {
    for (const model of ["claude-opus-4-8", "claude-opus-4.8", "anthropic/claude-opus-4-8"]) {
      expect(estimateLlmCostUsd(model, 1_000_000, 0, 1_000_000), model).toBeCloseTo(0.5, 10);
    }
  });
  it("does not change uncached base rates, other model caches, unknown estimates or CLI unknown cost", () => {
    expect(estimateLlmCostUsd("claude-opus-5-5", 1_000_000, 1_000_000)).toBe(24);
    expect(estimateLlmCostUsd("gpt-5.5", 1_000_000, 0, 1_000_000)).toBe(0.5);
    expect(estimateLlmCostUsd("muse-wonder", 1_000_000, 0, 1_000_000)).toBe(0.4);
    expect(estimateLlmCostUsd("muse-wonder-1.0-contributor", 1_000_000, 0, 1_000_000)).toBeUndefined();
    expect(estimateLlmCostUsd("claude-opus-5-5", 0, 0, 0)).toBeUndefined();
  });
  it("does not apply the new multiplier to a dated/unknown historical family identity", () => {
    // Test only the multiplier against that identity's existing base estimate.
    // Broad canonical fallback for unlisted snapshots is a separate existing caveat.
    for (const model of ["claude-opus-4-8-20260315", "claude-opus-unknown-future"]) {
      const base = estimateLlmCostUsd(model, 1_000_000, 0)!;
      expect(estimateLlmCostUsd(model, 1_000_000, 0, 1_000_000)).toBeCloseTo(base * 0.1, 10);
    }
  });
  it("retains cache-token clamping", () => {
    expect(estimateLlmCostUsd("claude-opus-5-5", 1000, 0, 999999)).toBeCloseTo(0.0002, 10);
    expect(estimateLlmCostUsd("claude-opus-5-5", 1000, 0, -10)).toBeCloseTo(0.004, 10);
  });
});


describe("Opus cache price through the real usage ledger", () => {
  it.each([
    { context: "opus-cache-billed-zero", provider: "openrouter", billed: 0, expected: 0, source: "billed" },
    { context: "opus-cache-billed-nonzero", provider: "openrouter", billed: 0.17, expected: 0.17, source: "billed" },
    { context: "opus-cache-no-billed", provider: "openrouter", billed: undefined, expected: 0.2, source: "estimated" },
    { context: "opus-cache-nontransport-cost", provider: "anthropic", billed: 0.99, expected: 0.2, source: "estimated" }
  ] as const)("preserves $source precedence for $context", ({ context, provider, billed, expected, source }) => {
    recordLlmUsage({ userId: "local", provider, model: "anthropic/claude-opus-5-5", context, keySource: "user", promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 1_000_000, billedCostUsd: billed });
    const row = getDb().prepare("SELECT cost_usd, cost_source, provider, model FROM llm_usage WHERE context = ?").get(context) as { cost_usd: number; cost_source: string; provider: string; model: string };
    expect(row).toMatchObject({ cost_source: source, provider, model: "anthropic/claude-opus-5-5" });
    expect(row.cost_usd).toBeCloseTo(expected, 10);
  });
});

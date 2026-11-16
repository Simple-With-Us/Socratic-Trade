import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;
afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// Base rates checked 2026-11-13, not a network call in this regression suite:
// https://platform.claude.com/docs/en/models/opus-5-5/overview
// https://openrouter.ai/api/v1/models?limit=500
const currentIds = [
  "claude-opus-latest", "claude-opus-5-5", "claude-opus-5.5",
  "anthropic/claude-opus-5-5", "anthropic/claude-opus-5.5",
  "~anthropic/claude-opus-latest", "openrouter/anthropic/claude-opus-5.5",
  "openrouter/~anthropic/claude-opus-latest"
];

describe("Opus 5.5 base price estimates", () => {
  let estimate: typeof import("../src/lib/llm-usage").estimateLlmCostUsd;
  beforeAll(async () => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `opus-price-${randomUUID()}.db`)}`;
    estimate = (await import("../src/lib/llm-usage")).estimateLlmCostUsd;
  });
  it.each(currentIds)("prices %s input/output separately at current base rates", (model) => {
    expect(estimate(model, 1_000_000, 0)).toBe(4);
    expect(estimate(model, 0, 1_000_000)).toBe(20);
    expect(estimate(model, 250_000, 50_000)).toBe(2);
  });
  it.each(["claude-opus-5", "claude-opus-4-8", "claude-opus-4.8", "anthropic/claude-opus-5", "anthropic/claude-opus-4.8"])("keeps historical %s prices separate", (model) => {
    expect(estimate(model, 1_000_000, 0)).toBe(5);
    expect(estimate(model, 0, 1_000_000)).toBe(25);
  });
  it("keeps unknown usage and Code CLI-only prices unknown", () => {
    expect(estimate("claude-opus-latest", 0, 0)).toBeUndefined();
    expect(estimate("muse-wonder-1.0-contributor", 1_000_000, 1_000_000)).toBeUndefined();
  });
});

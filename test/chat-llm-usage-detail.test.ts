/**
 * ST-4543: the chat path must hand the provider's cache, reasoning, served-model and billed-cost
 * figures to the ledger (they used to be dropped, so the Usage Monitor push never saw them).
 * Transport is injected, so this runs offline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordLlmUsage = vi.fn();
vi.mock("../src/lib/llm-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm-usage")>();
  return { ...actual, recordLlmUsage: (...a: unknown[]) => recordLlmUsage(...a) };
});

import { AnthropicLLM, OpenAILLM } from "../src/lib/chat/llm";
import type { LlmRunArgs } from "../src/lib/chat/types";

const baseArgs: LlmRunArgs = {
  system: "You are a trading assistant.",
  message: "Hello",
  tools: [],
  executeTool: async () => ({ ok: true })
};
const usage = { userId: "user-detail", keySource: "user" as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastRow = () => recordLlmUsage.mock.calls.at(-1)![0] as Record<string, any>;

beforeEach(() => recordLlmUsage.mockReset());

describe("chat usage detail", () => {
  it("threads Anthropic cache reads, 5m/1h cache writes and the served model", async () => {
    const llm = new AnthropicLLM("k", "claude-sonnet-5-5", async () => ({
      model: "claude-sonnet-5-5-20261001",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 }
      }
    }), usage);
    await llm.run(baseArgs);
    expect(lastRow()).toMatchObject({
      promptTokens: 5100,
      completionTokens: 50,
      cachedPromptTokens: 4000,
      cacheCreationTokens: 1000,
      cacheCreation1hTokens: 600,
      servedModel: "claude-sonnet-5-5-20261001"
    });
    expect(lastRow().requestCount).toBeUndefined();
  });

  it("threads OpenRouter billed cost, cached and reasoning tokens, and sums a two-step tool loop", async () => {
    let step = 0;
    const llm = new OpenAILLM("k", "anthropic/claude-sonnet-5.5", async () => {
      step += 1;
      return step === 1
        ? {
            id: "gen-1",
            model: "anthropic/claude-sonnet-5.5-20261001",
            choices: [{ message: { content: null, tool_calls: [{ id: "t1", function: { name: "noop", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 }, cost: 0.01 }
          }
        : {
            id: "gen-2",
            model: "anthropic/claude-sonnet-5.5-20261001",
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1200, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens_details: { reasoning_tokens: 40 }, cost: 0.02 }
          };
    }, usage, "openrouter");
    await llm.run(baseArgs);
    const row = lastRow();
    expect(row).toMatchObject({
      provider: "openrouter",
      promptTokens: 2200,
      completionTokens: 300,
      cachedPromptTokens: 1500,
      reasoningTokens: 40,
      servedModel: "anthropic/claude-sonnet-5.5-20261001",
      requestCount: 2
    });
    expect(row.billedCostUsd).toBeCloseTo(0.03, 10);
    // Two generations: a single generation id cannot verify the run's cost.
    expect(row.providerRequestId).toBeUndefined();
  });

  it("does not claim a billed cost when only some steps reported one", async () => {
    let step = 0;
    const llm = new OpenAILLM("k", "anthropic/claude-sonnet-5.5", async () => {
      step += 1;
      return step === 1
        ? {
            choices: [{ message: { content: null, tool_calls: [{ id: "t1", function: { name: "noop", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.01 }
          }
        : { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
    }, usage, "openrouter");
    await llm.run(baseArgs);
    expect(lastRow().billedCostUsd).toBeUndefined();
  });
});

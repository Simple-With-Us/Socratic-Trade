import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DD_LLMOBS_DAILY_CAP,
  isLlmProviderUrl,
  resetDatadogLlmObsForTests,
  withDatadogLlmObs,
  datadogLlmObsEmittedForTests
} from "../src/lib/datadog-llmobs";

afterEach(() => {
  resetDatadogLlmObsForTests();
  vi.unstubAllEnvs();
  delete (globalThis as { _ddtrace?: unknown })._ddtrace;
});

describe("Datadog LLM Observability wrapper", () => {
  it("recognizes OpenRouter, OpenAI, and MiniMax hosts and ignores Infisical", () => {
    expect(isLlmProviderUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
    expect(isLlmProviderUrl("https://api.openai.com/v1/chat/completions")).toBe(true);
    expect(isLlmProviderUrl("https://api.minimax.io/v1/chat/completions")).toBe(true);
    expect(isLlmProviderUrl("https://app.infisical.com/api/v3/secrets")).toBe(false);
  });

  it("runs the fetch without wrapping when APM is off", async () => {
    vi.stubEnv("DD_TRACE_ENABLED", "false");
    const fn = vi.fn(async () => "ok");
    await expect(withDatadogLlmObs("https://openrouter.ai/api/v1/chat/completions", {}, fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it.each([
    ["https://openrouter.ai/api/v1/chat/completions", "openrouter", "x"],
    ["https://api.minimax.io/v1/chat/completions", "minimax", "MiniMax-M3.1-Flash"]
  ])("wraps %s through dd-trace LLMObs with provider attribution", async (url, provider, model) => {
    vi.stubEnv("DD_API_KEY", "test-key");
    const wrap = vi.fn((_opts: unknown, fn: () => Promise<unknown>) => async () => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    const fn = vi.fn(async () => 42);
    await expect(
      withDatadogLlmObs(
        url,
        { body: JSON.stringify({ model }) },
        fn
      )
    ).resolves.toBe(42);
    expect(wrap).toHaveBeenCalledOnce();
    expect(wrap.mock.calls[0][0]).toMatchObject({
      kind: "llm",
      modelProvider: provider,
      modelName: model
    });
    expect(datadogLlmObsEmittedForTests()).toBe(1);
  });

  it("stops wrapping after the daily Free-tier cap", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    const wrap = vi.fn((_opts: unknown, fn: () => Promise<unknown>) => async () => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    const url = "https://openrouter.ai/api/v1/chat/completions";
    for (let i = 0; i < DD_LLMOBS_DAILY_CAP + 3; i += 1) {
      await withDatadogLlmObs(url, {}, async () => i);
    }
    expect(wrap).toHaveBeenCalledTimes(DD_LLMOBS_DAILY_CAP);
  });
});

import { describe, expect, it, afterEach, vi } from "vitest";
import {
  isReasoningModel,
  resolveOpenAiModel,
  withLlmRequestBounds,
  DEFAULT_OPENAI_MODEL,
  interactiveStrategyReasoningEffort,
  isDisallowedInteractiveStrategyReasoningConfig,
  reasoningCapabilityForModel,
  normalizeReasoningEffortForModel
} from "../src/lib/llm-request";

describe("llm-request — model resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("classifies reasoning vs classic models", () => {
    expect(isReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isReasoningModel("gpt-5.5")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel(undefined)).toBe(false);
  });

  it("resolves per-user policy model over env over default", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1-mini");
    expect(resolveOpenAiModel({ llmModel: "gpt-5.5" })).toBe("gpt-5.5");
    expect(resolveOpenAiModel({ llmModel: "  " })).toBe("gpt-4.1-mini"); // blank policy → env
    expect(resolveOpenAiModel(null)).toBe("gpt-4.1-mini");
    vi.unstubAllEnvs();
    expect(resolveOpenAiModel(null)).toBe(DEFAULT_OPENAI_MODEL);
  });

  it("disallows the slowest gpt-5.5 high-reasoning combo for interactive strategy runs", () => {
    expect(isDisallowedInteractiveStrategyReasoningConfig("gpt-5.5", "high")).toBe(true);
    expect(isDisallowedInteractiveStrategyReasoningConfig("gpt-5.5", "xhigh")).toBe(true);
    expect(isDisallowedInteractiveStrategyReasoningConfig("gpt-5.5", "medium")).toBe(false);
    expect(isDisallowedInteractiveStrategyReasoningConfig("gpt-5.4-mini", "high")).toBe(false);
    expect(interactiveStrategyReasoningEffort("gpt-5.5", "high")).toBe("medium");
    expect(interactiveStrategyReasoningEffort("gpt-5.5", "xhigh")).toBe("medium");
    expect(interactiveStrategyReasoningEffort("gpt-5.5", "low")).toBe("low");
    expect(interactiveStrategyReasoningEffort("gpt-4.1-mini", "high")).toBeUndefined();
  });

  it("maps provider-specific reasoning controls by model family", () => {
    expect(reasoningCapabilityForModel("gpt-5.4-mini")?.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(reasoningCapabilityForModel("claude-fable-5")?.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reasoningCapabilityForModel("grok-4.3")?.options.map((o) => o.value)).toEqual(["none", "low", "medium", "high"]);
    expect(reasoningCapabilityForModel("gemini-2.5-flash")?.options.map((o) => o.value)).toEqual(["none", "minimal", "low", "medium", "high"]);
    expect(reasoningCapabilityForModel("gemini-3.1-pro-preview")?.options.map((o) => o.value)).toEqual(["minimal", "low", "medium", "high"]);
    expect(reasoningCapabilityForModel("mistral-small-2603")?.options.map((o) => o.value)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
    expect(reasoningCapabilityForModel("deepseek-v4-pro")?.options.map((o) => o.value)).toEqual(["none", "high", "max"]);
  });

  it("normalizes unsupported effort values to the nearest provider-supported setting", () => {
    expect(normalizeReasoningEffortForModel("gpt-5.4-mini", "xhigh")).toBe("high");
    expect(normalizeReasoningEffortForModel("gemini-3.1-pro-preview", "none")).toBe("minimal");
    expect(normalizeReasoningEffortForModel("claude-opus-4-8", undefined)).toBe("medium");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", undefined)).toBe("high");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", "low")).toBe("high");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", "xhigh")).toBe("max");
  });
});

describe("llm-request — withLlmRequestBounds", () => {
  it("classic models keep temperature and exact token cap (no reasoning_effort)", () => {
    const chat = withLlmRequestBounds({ model: "gpt-4.1-mini" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gpt-4.1-mini"
    });
    expect(chat.temperature).toBe(0);
    expect(chat.max_completion_tokens).toBe(1500);
    expect("reasoning_effort" in chat).toBe(false);

    const resp = withLlmRequestBounds({ model: "gpt-4.1-mini" }, "responses", {
      maxOutputTokens: 1500,
      model: "gpt-4.1-mini"
    });
    expect(resp.temperature).toBe(0);
    expect(resp.max_output_tokens).toBe(1500);
    expect("reasoning" in resp).toBe(false);
  });

  it("reasoning models drop temperature, add reasoning_effort, and raise the token cap", () => {
    const chat = withLlmRequestBounds({ model: "gpt-5.4-mini" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium"
    });
    expect("temperature" in chat).toBe(false);
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.max_completion_tokens).toBe(1500 + 4000); // medium headroom

    const resp = withLlmRequestBounds({ model: "gpt-5.5" }, "responses", {
      maxOutputTokens: 1500,
      model: "gpt-5.5",
      reasoningEffort: "low"
    });
    expect("temperature" in resp).toBe(false);
    expect(resp.reasoning).toEqual({ effort: "low" });
    expect(resp.max_output_tokens).toBe(1500 + 2000); // low headroom
  });

  it("provider reasoning models use their provider-specific wire shapes", () => {
    const gemini = withLlmRequestBounds({ model: "gemini-2.5-flash" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gemini-2.5-flash",
      reasoningEffort: "none"
    });
    expect(gemini.reasoning_effort).toBe("none");
    expect(gemini.max_completion_tokens).toBe(1500);

    const xai = withLlmRequestBounds({ model: "grok-4.3" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "grok-4.3",
      reasoningEffort: "high"
    });
    expect(xai.reasoning_effort).toBe("high");
    // Reasoning-token headroom (composite review B/high/S) is no longer OpenAI-only: xAI bills
    // hidden reasoning tokens against the same max_completion_tokens cap as the visible JSON.
    expect(xai.max_completion_tokens).toBe(1500 + 8000);

    const mistral = withLlmRequestBounds({ model: "mistral-large-2512" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "mistral-large-2512",
      reasoningEffort: "xhigh"
    });
    expect(mistral.reasoning_effort).toBe("xhigh");
    expect(mistral.prompt_mode).toBe("reasoning");
    expect(mistral.max_completion_tokens).toBe(1500 + 12000);

    const deepseek = withLlmRequestBounds({ model: "deepseek-v4-pro" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    expect(deepseek.reasoning_effort).toBe("max");
    expect(deepseek.thinking).toEqual({ type: "enabled" });
    expect("temperature" in deepseek).toBe(false);
    expect(deepseek.max_completion_tokens).toBe(1500 + 16000);

    const deepseekOff = withLlmRequestBounds({ model: "deepseek-v4-flash" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "deepseek-v4-flash",
      reasoningEffort: "none"
    });
    expect(deepseekOff.thinking).toEqual({ type: "disabled" });
    expect(deepseekOff.temperature).toBe(0);

    const anthropic = withLlmRequestBounds({ model: "claude-opus-4-8" }, "anthropic-messages", {
      maxOutputTokens: 1500,
      model: "claude-opus-4-8",
      reasoningEffort: "max"
    });
    expect(anthropic.thinking).toEqual({ type: "adaptive" });
    expect(anthropic.output_config).toEqual({ effort: "max" });
    expect("temperature" in anthropic).toBe(false);
  });

  it("reasoning models default to medium effort when unspecified", () => {
    const chat = withLlmRequestBounds({ model: "gpt-5.4-nano" }, "chat-completions", {
      maxOutputTokens: 1000,
      model: "gpt-5.4-nano"
    });
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.max_completion_tokens).toBe(1000 + 4000);
  });

  // Composite review B/high/S: "Reasoning-token headroom exists only for OpenAI — other providers'
  // reasoning calls starve the JSON answer." Assert, for EVERY reasoning-capable provider and EVERY
  // effort level it supports, that the effective visible-output budget (max_completion_tokens /
  // max_output_tokens / max_tokens minus the hidden-reasoning headroom) is always >= the requested
  // cap — i.e. hidden reasoning tokens never eat into the caller's requested visible budget.
  it("every provider x effort combination preserves the full requested visible-output budget", () => {
    const requestedCap = 1500;
    const modelsByProvider: Record<string, string> = {
      openai: "gpt-5.4-mini",
      xai: "grok-4.3",
      gemini: "gemini-2.5-flash",
      mistral: "mistral-large-2512",
      deepseek: "deepseek-v4-pro",
      anthropic: "claude-opus-4-8"
    };

    for (const [provider, model] of Object.entries(modelsByProvider)) {
      const capability = reasoningCapabilityForModel(model);
      expect(capability?.provider, `expected a reasoning capability for ${model}`).toBe(provider);
      for (const option of capability!.options) {
        const transport = provider === "anthropic" ? "anthropic-messages" : provider === "openai" ? "responses" : "chat-completions";
        const bounded = withLlmRequestBounds(
          { model },
          transport,
          { maxOutputTokens: requestedCap, model, reasoningEffort: option.value }
        );
        const effectiveCap =
          (bounded.max_completion_tokens as number | undefined) ??
          (bounded.max_output_tokens as number | undefined) ??
          (bounded.max_tokens as number | undefined);
        expect(
          effectiveCap,
          `provider=${provider} model=${model} effort=${option.value} must expose a token cap`
        ).toBeDefined();
        expect(
          effectiveCap!,
          `provider=${provider} effort=${option.value}: effective visible-output budget (${effectiveCap}) must be >= requested cap (${requestedCap})`
        ).toBeGreaterThanOrEqual(requestedCap);
      }
    }
  });
});

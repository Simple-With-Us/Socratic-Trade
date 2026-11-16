import { describe, expect, it } from "vitest";
import {
  ALL_LLM_REASONING_EFFORTS, LLM_MODEL_ROTATION_SENTINEL, ROTATION_UI_REASONING_CAPABILITY,
  interactiveStrategyReasoningEffort, isDisallowedInteractiveStrategyReasoningConfig,
  isModelRotationSentinel, isReasoningModel, lowerModel, normalizeReasoningEffortForModel,
  normalizeReasoningEffortForOptions, reasoningCapabilityForModel, resolveOpenAiModel,
  resolveReviewerReasoningEffort
} from "../src/lib/llm-reasoning";

const values = (model: string) => reasoningCapabilityForModel(model)?.options.map(option => option.value);

describe("pure reasoning capability selection", () => {
  it.each([
    ["openai/gpt-5.6", "openai", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["o1", "openai", ["low", "medium", "high"]],
    ["anthropic/claude-sonnet-5", "anthropic", ["low", "medium", "high", "xhigh", "max"]],
    ["x-ai/grok-4.6", "xai", ["low", "medium", "high", "xhigh"]],
    ["grok-4", "xai", ["none", "low", "medium", "high"]],
    ["gemini-2.5-flash", "gemini", ["none", "minimal", "low", "medium", "high"]],
    ["gemini-3.8-flash", "gemini", ["low", "medium", "high"]],
    ["gemini-3-pro", "gemini", ["minimal", "low", "medium", "high"]],
    ["mistral-medium-3-5", "mistral", ["none", "high"]],
    ["deepseek-v4-pro", "deepseek", ["none", "high", "max"]],
    // ST-4589 (2026-11-04)
    // Native Haiku 5.5 is adaptive like the OpenRouter alias (Anthropic thinking docs).
    ["claude-haiku-5-5", "anthropic", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-haiku-latest", "anthropic", ["low", "medium", "high", "xhigh", "max"]],
    ["grok-4.7", "xai", ["low", "medium", "high", "xhigh"]],
    ["grok-latest", "xai", ["low", "medium", "high", "xhigh"]],
    ["mistral-large-latest", "mistral", ["high"]],
    ["mistralai/mistral-large-4-0", "mistral", ["high"]],
    // DeepSeek V4.1 Flash and the bare native id keep the thinking controls.
    ["~deepseek/deepseek-flash-latest", "deepseek", ["none", "high", "max"]],
    ["deepseek-flash", "deepseek", ["none", "high", "max"]],
    ["deepseek/deepseek-v4.1-flash-1017", "deepseek", ["none", "high", "max"]],
    ["minimax-m3.1-flash", "minimax", ["low", "medium", "high", "xhigh", "max"]],
    ["minimax/minimax-m3.1-flash", "minimax", ["low", "medium", "high", "xhigh", "max"]],
    ["MiniMax-M3.1-Flash", "minimax", ["low", "medium", "high", "xhigh", "max"]],
    ["muse-spark-1.3", "meta", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    ["meta/muse-wonder", "meta", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    ["muse-wonder-1.0", "meta", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    ["muse-spark-1.3-contributor", "meta", ["minimal", "low", "medium", "high", "xhigh"]],
    ["meta/muse-spark-1.3-contributor", "meta", ["minimal", "low", "medium", "high", "xhigh"]],
    ["muse-wonder-1.0-contributor", "meta", ["minimal", "low", "medium", "high", "xhigh"]],
    ["muse-wonder-full-1.0-contributor", "meta", ["minimal", "low", "medium", "high", "xhigh"]],
    ["muse-glimmer-30b", "meta", ["low", "medium", "high", "xhigh"]]
  ])("selects %s without credential imports", (model, provider, efforts) => {
    expect(reasoningCapabilityForModel(model as string)?.provider).toBe(provider);
    expect(values(model as string)).toEqual(efforts);
  });
  it("does not give unsupported models or rotation a wire capability", () => {
    // MiniMax-M3 has no documented effort parameter (MiniMax guide and OpenRouter both silent), and
    // the deprecated Large 3 snapshot never reasoned: no knob for either.
    for (const model of [undefined, "", "gpt-4.1-mini", "mistral-small-latest", "minimax-m3", "MiniMax-M3", "minimax/minimax-m3", "mistral-large-2512", LLM_MODEL_ROTATION_SENTINEL]) {
      expect(reasoningCapabilityForModel(model)).toBeUndefined();
      expect(normalizeReasoningEffortForModel(model, "high")).toBeUndefined();
    }
    expect(ROTATION_UI_REASONING_CAPABILITY.provider).toBe("rotation");
    expect(ROTATION_UI_REASONING_CAPABILITY.options.map(o => o.value)).toEqual(ALL_LLM_REASONING_EFFORTS);
  });
  it("normalizes names and detects reasoning models", () => {
    expect(lowerModel(" OpenAI/GPT-5.6 ")).toBe("gpt-5.6");
    expect(lowerModel(undefined)).toBe("");
    expect(isReasoningModel("openai/o3")).toBe(true);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
  });
});

describe("effort clamping without silent expensive opt-in", () => {
  it.each([undefined, "none", "minimal", "low", "medium"] as const)("keeps %s on fast DeepSeek/Mistral tiers", effort => {
    expect(normalizeReasoningEffortForModel("deepseek-v4-flash", effort)).toBe("none");
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", effort)).toBe("none");
  });
  it.each(["high", "xhigh", "max"] as const)("honors explicit %s opt-in", effort => {
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", effort)).toBe("high");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", effort)).toBe(effort === "high" ? "high" : "max");
  });
  it("MiniMax and Muse default to medium, never send none, and contributor models never max (ST-4589)", () => {
    for (const model of ["minimax-m3.1-flash", "muse-spark-1.3", "muse-wonder-1.0", "muse-spark-1.3-contributor", "muse-wonder-1.0-contributor", "muse-glimmer-30b"]) {
      expect(normalizeReasoningEffortForModel(model, undefined), model).toBe("medium");
      expect(normalizeReasoningEffortForModel(model, "none"), model).not.toBe("none");
    }
    expect(normalizeReasoningEffortForModel("minimax-m3.1-flash", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("minimax-m3.1-flash", "none")).toBe("low");
    expect(normalizeReasoningEffortForModel("muse-spark-1.3", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("muse-spark-1.3", "none")).toBe("minimal");
    expect(normalizeReasoningEffortForModel("muse-spark-1.3-contributor", "max")).toBe("xhigh");
    expect(normalizeReasoningEffortForModel("meta/muse-spark-1.3-contributor", "max")).toBe("xhigh");
    expect(normalizeReasoningEffortForModel("muse-wonder-full-1.0-contributor", "max")).toBe("xhigh");
    // Mistral Large 4 accepts only high (the opt-in none/high rule stays on Medium 3.5 only).
    expect(normalizeReasoningEffortForModel("mistral-large-latest", undefined)).toBe("high");
    expect(normalizeReasoningEffortForModel("mistral-large-latest", "none")).toBe("high");
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", undefined)).toBe("none");
  });
  it("defaults and clamps generic options with lower-tier tie breaking", () => {
    expect(normalizeReasoningEffortForOptions([], "max")).toBe("medium");
    expect(normalizeReasoningEffortForOptions([{ value: "low" }, { value: "high" }], undefined)).toBe("low");
    expect(normalizeReasoningEffortForOptions([{ value: "low" }, { value: "high" }], "medium")).toBe("low");
    expect(normalizeReasoningEffortForModel("o1", undefined)).toBe("medium");
    expect(normalizeReasoningEffortForModel("o1", "max")).toBe("high");
  });
  it("applies the interactive GPT-5.5 high override only to that model", () => {
    expect(isDisallowedInteractiveStrategyReasoningConfig("openai/gpt-5.5", "high")).toBe(true);
    expect(interactiveStrategyReasoningEffort("gpt-5.5", "high")).toBe("medium");
    expect(interactiveStrategyReasoningEffort("gpt-5.6", "high")).toBe("high");
    expect(interactiveStrategyReasoningEffort("gpt-4.1-mini", "high")).toBeUndefined();
  });
});

describe("policy resolution stays fail-closed", () => {
  it("recognizes rotation only by its exact trimmed sentinel", () => {
    expect(isModelRotationSentinel(" __rotate__ ")).toBe(true);
    for (const model of [null, undefined, "", "__ROTATE__", "gpt-5.6"]) expect(isModelRotationSentinel(model)).toBe(false);
  });
  it("never supplies a model default or serves a rotation sentinel", () => {
    for (const policy of [undefined, null, {}, { llmModel: " " }, { llmModel: "__rotate__" }]) expect(resolveOpenAiModel(policy)).toBe("");
    expect(resolveOpenAiModel({ llmModel: " openai/gpt-5.6 " })).toBe("openai/gpt-5.6");
  });
  it("uses reviewer override, then proposer effort, then unset", () => {
    expect(resolveReviewerReasoningEffort({ redTeamReasoningEffort: "none", llmReasoningEffort: "high" })).toBe("none");
    expect(resolveReviewerReasoningEffort({ llmReasoningEffort: "medium" })).toBe("medium");
    for (const policy of [undefined, null, {}]) expect(resolveReviewerReasoningEffort(policy)).toBeUndefined();
  });
});

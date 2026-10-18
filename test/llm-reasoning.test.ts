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
    ["deepseek-v4-pro", "deepseek", ["none", "high", "max"]]
  ])("selects %s without credential imports", (model, provider, efforts) => {
    expect(reasoningCapabilityForModel(model as string)?.provider).toBe(provider);
    expect(values(model as string)).toEqual(efforts);
  });
  it("does not give unsupported models or rotation a wire capability", () => {
    for (const model of [undefined, "", "gpt-4.1-mini", "mistral-small-latest", LLM_MODEL_ROTATION_SENTINEL]) {
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

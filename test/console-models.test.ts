import { describe, expect, it } from "vitest";
import { isOpenRouterRouted, modelDisplayName, providerForModel } from "../app/console/lib/models";

// Universal OpenRouter routing (PR #1703) means a model call now shows up vendor-qualified
// (resolveLlmEndpoint's prefixes: anthropic/, x-ai/, google/, mistralai/, deepseek/) wherever a
// raw model id is read back — decisions, usage, approval cards. Before this fix, providerForModel
// and modelDisplayName only handled bare ids, so an OpenRouter-routed Grok or Gemini call branded
// as OpenAI and every routed id showed its raw vendor-qualified string instead of a display name.
describe("providerForModel — OpenRouter vendor-routing prefixes", () => {
  it("brands bare (pre-routing) ids correctly, unaffected by the fix", () => {
    expect(providerForModel("claude-sonnet-5")).toBe("anthropic");
    expect(providerForModel("grok-4.3")).toBe("xai");
    expect(providerForModel("gemini-3.5-flash")).toBe("gemini");
    expect(providerForModel("mistral-medium-3-5")).toBe("mistral");
    expect(providerForModel("deepseek-v4-pro")).toBe("deepseek");
    expect(providerForModel("gpt-5.6-terra")).toBe("openai");
  });

  it("brands OpenRouter-routed ids by their real vendor, not OpenAI", () => {
    expect(providerForModel("anthropic/claude-sonnet-5")).toBe("anthropic");
    // The regression this fix targets: x-ai/ and google/ prefixes don't start with "grok"/"gemini",
    // so they used to fall through to the "openai" default.
    expect(providerForModel("x-ai/grok-4.3")).toBe("xai");
    expect(providerForModel("google/gemini-3.5-flash")).toBe("gemini");
    expect(providerForModel("mistralai/mistral-medium-3-5")).toBe("mistral");
    expect(providerForModel("deepseek/deepseek-v4-pro")).toBe("deepseek");
  });

  it("handles the legacy explicit openrouter/vendor/model override shape", () => {
    expect(providerForModel("openrouter/anthropic/claude-3.5-sonnet")).toBe("anthropic");
    expect(providerForModel("openrouter/google/gemini-2.5-pro")).toBe("gemini");
  });

  it("still falls through to openai for unknown/custom ids", () => {
    expect(providerForModel("some-custom-finetune")).toBe("openai");
    expect(providerForModel(null)).toBe("openai");
    expect(providerForModel(undefined)).toBe("openai");
  });
});

describe("modelDisplayName — strips the OpenRouter routing prefix before the curated lookup", () => {
  it("resolves a curated model routed through OpenRouter to its curated display name, not the raw id", () => {
    expect(modelDisplayName("x-ai/grok-4.3")).toBe("Grok 4.3");
    expect(modelDisplayName("google/gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
    expect(modelDisplayName("anthropic/claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  it("falls back to the bare id (prefix stripped) for a routed but uncatalogued model", () => {
    expect(modelDisplayName("anthropic/claude-3.5-sonnet")).toBe("claude-3.5-sonnet");
  });

  it("is unaffected for bare ids (pre-routing / direct calls)", () => {
    expect(modelDisplayName("grok-4.3")).toBe("Grok 4.3");
    expect(modelDisplayName("")).toBe("");
    expect(modelDisplayName(null)).toBe("");
  });
});

describe("isOpenRouterRouted — transport signal, separate from vendor branding", () => {
  it("is true for any vendor-qualified id", () => {
    expect(isOpenRouterRouted("anthropic/claude-sonnet-5")).toBe(true);
    expect(isOpenRouterRouted("x-ai/grok-4.3")).toBe(true);
    expect(isOpenRouterRouted("openrouter/anthropic/claude-3.5-sonnet")).toBe(true);
  });

  it("is false for bare native/custom ids", () => {
    expect(isOpenRouterRouted("claude-sonnet-5")).toBe(false);
    expect(isOpenRouterRouted("some-custom-finetune")).toBe(false);
    expect(isOpenRouterRouted(null)).toBe(false);
    expect(isOpenRouterRouted(undefined)).toBe(false);
  });
});

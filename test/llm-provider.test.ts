/**
 * Tests for resolveLlmEndpoint — provider routing based on model name.
 * All tests run entirely offline (no real API key or network call required).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

// Point the DB at a temp file before any imports touch it.
const tmpDb = path.join(os.tmpdir(), `llm-provider-test-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

const LLM_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "META_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY"
];

function noEnvKeys() {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

describe("resolveLlmEndpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setApiKey: (...args: any[]) => any;

  beforeAll(async () => {
    // Ensure DB is initialised before module import.
    const { getDb } = await import("../src/lib/db");
    getDb();
    const dbApiKeys = await import("../src/lib/db-api-keys");
    setApiKey = dbApiKeys.upsertUserApiKey;
    const mod = await import("../src/lib/llm-provider");
    resolveLlmEndpoint = mod.resolveLlmEndpoint;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    noEnvKeys();
  });

  beforeAll(() => {
    noEnvKeys();
  });

  it("routes to OpenRouter when user has an OpenRouter key", () => {
    setApiKey("test-user-or", "openrouter", "sk-or-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "test-user-or");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(endpoint.key).toBe("sk-or-test-key");
    expect(endpoint.model).toBe("~anthropic/claude-sonnet-latest");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to native Anthropic endpoint when user has an Anthropic key but no OpenRouter key", () => {
    setApiKey("test-user-anthropic", "anthropic", "sk-ant-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "test-user-anthropic");
    expect(endpoint.provider).toBe("anthropic");
    expect(endpoint.url).toBe("https://api.anthropic.com/v1/messages");
    expect(endpoint.key).toBe("sk-ant-test-key");
    expect(endpoint.model).toBe("claude-sonnet-5"); // native lags on purpose: Sonnet 5.5 rejects the forced-tool body
    expect(endpoint.transport).toBe("anthropic-messages");
  });

  it("falls back to native xAI endpoint when user has an xAI key but no OpenRouter key", () => {
    setApiKey("test-user-xai", "xai", "xai-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.5" }, "test-user-xai");
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(endpoint.key).toBe("xai-test-key");
    expect(endpoint.model).toBe("grok-4.7");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to native Moonshot endpoint when user has a Moonshot key but no OpenRouter key", () => {
    setApiKey("test-user-moonshot", "moonshot", "sk-moonshot-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "kimi-latest" }, "test-user-moonshot");
    expect(endpoint.provider).toBe("moonshot");
    expect(endpoint.url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(endpoint.key).toBe("sk-moonshot-test-key");
    expect(endpoint.model).toBe("kimi-k3.1-pro");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to the native MiniMax endpoint with the MiniMax credential", () => {
    setApiKey("test-user-minimax", "minimax", "sk-minimax-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "minimax-m3.1-flash" }, "test-user-minimax");
    expect(endpoint.provider).toBe("minimax");
    expect(endpoint.url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(endpoint.key).toBe("sk-minimax-test-key");
    expect(endpoint.model).toBe("MiniMax-M3.1-Flash");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("keeps a stored minimax-m3 selection on the retired row wire ids", () => {
    setApiKey("minimax-retired", "minimax", "sk-minimax-retired");
    const native = resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-retired");
    expect(native.provider).toBe("minimax");
    expect(native.model).toBe("MiniMax-M3");
    setApiKey("minimax-retired-or", "openrouter", "openrouter-placeholder");
    const routed = resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-retired-or");
    expect(routed.provider).toBe("openrouter");
    expect(routed.model).toBe("minimax/minimax-m3");
  });

  it("uses the same credential service for eligibility and actual MiniMax execution", async () => {
    const { modelCredentialService } = await import("../src/lib/llm-provider");
    setApiKey("minimax-eligibility", "minimax", "minimax-placeholder");
    expect(modelCredentialService("minimax-m3", "minimax-eligibility")).toBe("minimax");
    expect(resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-eligibility").provider).toBe("minimax");
    setApiKey("minimax-eligibility", "openrouter", "openrouter-placeholder");
    expect(modelCredentialService("minimax-m3", "minimax-eligibility")).toBe("openrouter");
    expect(resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-eligibility").provider).toBe("openrouter");
  });

  it("keeps an explicit OpenRouter model on OpenRouter even when its native key exists", async () => {
    const { modelCredentialService, modelRequiresOpenRouter } = await import("../src/lib/llm-provider");
    setApiKey("explicit-openrouter-minimax", "minimax", "minimax-placeholder");
    const model = "openrouter/minimax/minimax-m3";

    expect(modelRequiresOpenRouter(model)).toBe(true);
    expect(modelRequiresOpenRouter(" OpenRouter/~anthropic/claude-sonnet-latest ")).toBe(true);
    expect(modelCredentialService(model, "explicit-openrouter-minimax")).toBe("openrouter");
    const endpoint = resolveLlmEndpoint({ llmModel: model }, "explicit-openrouter-minimax");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.key).toBeUndefined();
    expect(endpoint.model).toBe("minimax/minimax-m3");
  });

  it("requires OpenRouter for Astra Pro even with a native OpenAI key", () => {
    setApiKey("astra-pro-native", "openai", "openai-placeholder");
    const endpoint = resolveLlmEndpoint({ llmModel: "gpt-6-astra-pro" }, "astra-pro-native");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.key).toBeUndefined();
    expect(endpoint.model).toBe("openai/gpt-6-astra-pro");
  });

  it("routes Muse Spark and MiniMax to the native API only when the user picks direct, OpenRouter otherwise", async () => {
    const { modelCredentialService } = await import("../src/lib/llm-provider");
    setApiKey("meta-native-only", "meta", "meta-placeholder");
    // OpenRouter is the default route: a stored Meta key alone changes nothing until "direct" is chosen.
    const { setUserSetting } = await import("../src/lib/db");
    expect(resolveLlmEndpoint({ llmModel: "muse-spark-1.3" }, "meta-native-only").provider).toBe("openrouter");
    setUserSetting("meta-native-only", "llm_route_meta", "native");
    // Glimmer is open-weight and not hosted on api.meta.ai, so it stays OpenRouter-only and a Meta
    // key is never sent to OpenAI or to OpenRouter.
    for (const model of ["muse-glimmer-30b"]) {
      const endpoint = resolveLlmEndpoint({ llmModel: model }, "meta-native-only");
      expect(endpoint.provider).toBe("openrouter");
      expect(endpoint.key).toBeUndefined();
      expect(modelCredentialService(model, "meta-native-only")).toBe("openrouter");
    }
    for (const [model, wire] of [["muse-spark-1.3", "muse-spark-1.3"], ["muse-spark-1.3-contributor", "muse-spark-1.3-contributor"], ["muse-wonder-1.0", "muse-wonder-1.0"]]) {
      const endpoint = resolveLlmEndpoint({ llmModel: model }, "meta-native-only");
      expect(endpoint.provider).toBe("meta");
      expect(endpoint.url).toBe("https://api.meta.ai/v1/chat/completions");
      expect(endpoint.model).toBe(wire);
      expect(endpoint.key).toBe("meta-placeholder");
      expect(endpoint.keySource).toBe("user");
      expect(modelCredentialService(model, "meta-native-only")).toBe("meta");
    }
    // An OpenRouter key does not pull Muse Spark off the native route while a Meta key exists.
    setApiKey("meta-native-only", "openrouter", "openrouter-placeholder");
    const native = resolveLlmEndpoint({ llmModel: "muse-spark-1.3" }, "meta-native-only");
    expect(native.provider).toBe("meta");
    expect(native.key).toBe("meta-placeholder");
    // MiniMax follows the same toggle: OpenRouter by default, direct once chosen.
    setApiKey("minimax-direct", "minimax", "minimax-placeholder");
    setApiKey("minimax-direct", "openrouter", "openrouter-placeholder");
    expect(resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-direct").provider).toBe("openrouter");
    expect(modelCredentialService("minimax-m3", "minimax-direct")).toBe("openrouter");
    setUserSetting("minimax-direct", "llm_route_minimax", "native");
    expect(modelCredentialService("minimax-m3", "minimax-direct")).toBe("minimax");
    const minimax = resolveLlmEndpoint({ llmModel: "minimax-m3" }, "minimax-direct");
    expect(minimax.provider).toBe("minimax");
    expect(minimax.key).toBe("minimax-placeholder");
    // OpenRouter-only users still get the OpenRouter wire id.
    setApiKey("openrouter-only", "openrouter", "openrouter-placeholder");
    for (const [model, wire] of [["muse-spark-1.3", "meta/muse-spark-1.3"], ["muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor"]]) {
      const endpoint = resolveLlmEndpoint({ llmModel: model }, "openrouter-only");
      expect(endpoint.provider).toBe("openrouter");
      expect(endpoint.model).toBe(wire);
      expect(endpoint.key).toBe("openrouter-placeholder");
    }
  });

  it("fails closed (key undefined) when user has no keys at all", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "user-with-no-keys");
    expect(endpoint.key).toBeUndefined();
  });

  it("maps Flash-class aliases to the owner OpenRouter Flash wire slug", async () => {
    const { normalizeOpenRouterModelId, OPENROUTER_GEMINI_FLASH, OPENROUTER_GEMINI_FLASH_BATCH } =
      await import("../src/lib/llm-provider");
    expect(normalizeOpenRouterModelId("gemini-flash-latest")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-flash-latest")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.8-flash:batch")).toBe(OPENROUTER_GEMINI_FLASH_BATCH);
    expect(normalizeOpenRouterModelId("gemini-3.5-flash")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.7-flash")).toBe(OPENROUTER_GEMINI_FLASH);
  });

  it("maps Mistral Medium to the owner OpenRouter wire slug", async () => {
    const { normalizeOpenRouterModelId } = await import("../src/lib/llm-provider");
    expect(normalizeOpenRouterModelId("mistral-medium-latest")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-medium-3-5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-medium-3.5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistralai/mistral-medium-3.5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistralai/mistral-medium-3-5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("gpt-5.4-nano")).toBe("openai/gpt-5.4-nano");
  });

  it("refuses a stored Llama id legibly as an unavailable (skippable) model, on every seat (ST-4589)", async () => {
    const provider = await import("../src/lib/llm-provider");
    setApiKey("llama-user", "openrouter", "openrouter-placeholder");
    for (const [policy, role] of [
      [{ llmModel: "llama-4-scout" }, "green"],
      [{ llmModel: "meta-llama/llama-3.3-70b-instruct" }, "green"],
      [{ redTeamLlmModel: "openrouter/meta-llama/llama-4-maverick" }, "red"]
    ] as const) {
      let caught: unknown;
      try { resolveLlmEndpoint(policy, "llama-user", undefined, role); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(provider.LlmModelUnavailableError);
      expect((caught as Error).message).toBe("Llama models are no longer offered; pick another model");
      expect(provider.isUnavailableModelResolutionError(caught)).toBe(true);
    }
    // A stale llama id still classifies as Meta, so nothing can ever route it to api.openai.com.
    expect(provider.llmModelFamily("llama-4-scout")).toBe("meta");
  });

  it("emits owner OpenRouter wire slugs for catalog families and aliases", async () => {
    const { normalizeOpenRouterModelId } = await import("../src/lib/llm-provider");
    const cases: Array<[string, string]> = [
      ["claude-sonnet-5", "~anthropic/claude-sonnet-latest"],
      ["claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["~anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["openrouter/~anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"],
      ["claude-haiku-4.5", "~anthropic/claude-haiku-latest"],
      ["claude-haiku-latest", "~anthropic/claude-haiku-latest"],
      ["anthropic/claude-haiku-latest", "~anthropic/claude-haiku-latest"],
      ["~anthropic/claude-haiku-latest", "~anthropic/claude-haiku-latest"],
      ["claude-opus-5", "~anthropic/claude-opus-latest"],
      ["claude-opus-latest", "~anthropic/claude-opus-latest"],
      ["anthropic/claude-opus-latest", "~anthropic/claude-opus-latest"],
      ["~anthropic/claude-opus-latest", "~anthropic/claude-opus-latest"],
      ["claude-fable-5", "~anthropic/claude-fable-latest"],
      ["claude-fable-latest", "~anthropic/claude-fable-latest"],
      ["anthropic/claude-fable-latest", "~anthropic/claude-fable-latest"],
      ["~anthropic/claude-fable-latest", "~anthropic/claude-fable-latest"],
      ["grok-4.5", "~x-ai/grok-latest"],
      ["grok-latest", "~x-ai/grok-latest"],
      ["x-ai/grok-latest", "~x-ai/grok-latest"],
      ["~x-ai/grok-latest", "~x-ai/grok-latest"],
      ["gpt-6-astra", "openai/gpt-6-astra"],
      ["openai/gpt-6-astra", "openai/gpt-6-astra"],
      ["~openai/gpt-6-astra", "openai/gpt-6-astra"],
      // kimi-latest pins moonshotai/kimi-k3.1-pro (2026-11-04): OpenRouter's ~kimi-latest alias still targets K3.
      ["kimi-latest", "moonshotai/kimi-k3.1-pro"],
      ["moonshotai/kimi-latest", "moonshotai/kimi-k3.1-pro"],
      ["~moonshotai/kimi-latest", "moonshotai/kimi-k3.1-pro"],
      ["gpt-sol-latest", "openai/gpt-6.1-sol"],
      ["gpt-6.1-terra", "openai/gpt-6.1-terra"],
      ["gpt-luna-latest", "openai/gpt-6-luna"],
      ["gpt-5.6-sol", "openai/gpt-5.6-sol"],
      ["gpt-5.6-luna", "openai/gpt-5.6-luna"],
      ["gpt-6-astra-pro", "openai/gpt-6-astra-pro"],
      ["minimax-m3.1-flash", "minimax/minimax-m3.1-flash"],
      ["muse-wonder-1.0", "meta/muse-wonder"],
      ["deepseek-flash-latest", "~deepseek/deepseek-flash-latest"],
      ["mistral-large-latest", "mistralai/mistral-large-4-0"],
      ["minimax-m3", "minimax/minimax-m3"],
      ["minimax/minimax-m3", "minimax/minimax-m3"],
      // 2026-09-18: deepseek-r1 / deepseek-reasoner removed from the curated catalog. Both
      // go through the vendor-prefix fallback now and yield their literal vendor-prefixed
      // slug — the old alias mapping to 'deepseek/deepseek-r1' no longer applies.
      ["deepseek/deepseek-reasoner", "deepseek/deepseek-reasoner"],
      ["deepseek-r1", "deepseek/deepseek-r1"]
    ];
    for (const [input, expected] of cases) {
      expect(normalizeOpenRouterModelId(input), input).toBe(expected);
    }
  });
});

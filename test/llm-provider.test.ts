/**
 * Tests for resolveLlmEndpoint — provider routing based on model name.
 * All tests run entirely offline (no real API key or network call required).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

// Point the DB at a temp file before any imports touch it.
const tmpDb = path.join(os.tmpdir(), `llm-provider-test-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

describe("resolveLlmEndpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => any;

  beforeAll(async () => {
    // Ensure DB is initialised before module import.
    const { getDb } = await import("../src/lib/db");
    getDb();
    const mod = await import("../src/lib/llm-provider");
    resolveLlmEndpoint = mod.resolveLlmEndpoint;
  });

  const getExpectedUrl = () => process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions";

  it("routes grok-4.3 to OpenRouter with chat-completions transport", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "xai/grok-4.3" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe(getExpectedUrl());
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("xai/grok-4.3");
  });

  it("routes grok-build-0.1 to OpenRouter (case-insensitive prefix match)", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-build-0.1" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe(getExpectedUrl());
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("x-ai/grok-build-0.1");
  });

  it("routes gpt-5.4-mini to OpenRouter with openai/ prefix", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe(getExpectedUrl());
    expect(endpoint.model).toBe("openai/gpt-5.4-mini");
  });

  it("routes the Red Team through redTeamLlmModel when configured", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "xai/grok-4.3" },
      "local",
      "https://openrouter.ai/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("xai/grok-4.3");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("resolves the Red Team to \"\" (unconfigured) when no redTeamLlmModel is set — never falls back to Green (owner 2026-07-07)", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini" },
      "local",
      "https://openrouter.ai/v1/responses",
      "red"
    );
    expect(endpoint.model).toBe("");
  });

  it("allows the SAME model for Green and Red when the user explicitly chooses it (owner 2026-07-07)", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "gpt-5.4-mini" },
      "local",
      "https://openrouter.ai/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("openai/gpt-5.4-mini");
  });

  it("routes empty/no policy to OpenRouter with an unconfigured (\"\") model (owner 2026-07-07)", () => {
    const endpoint = resolveLlmEndpoint({});
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("");
  });

  it("routes gemini-* to OpenRouter via OpenAI-compatible chat-completions", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "gemini-2.5-flash" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe(getExpectedUrl());
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("google/gemini-2.5-flash");
  });

  it("routes mistral-* (and ministral/codestral) to OpenRouter", () => {
    for (const model of ["mistral-large-2512", "ministral-3b-latest", "codestral-latest"]) {
      const endpoint = resolveLlmEndpoint({ llmModel: model });
      expect(endpoint.provider).toBe("openrouter");
      expect(endpoint.url).toBe(getExpectedUrl());
      expect(endpoint.transport).toBe("chat-completions");
      expect(endpoint.model).toBe(`mistralai/${model}`);
    }
  });

  it("honors OPENROUTER_API_URL overrides", () => {
    const savedUrl = process.env.OPENROUTER_API_URL;
    process.env.OPENROUTER_API_URL = "https://custom.openrouter.example.com/v1/chat/completions";
    try {
      expect(resolveLlmEndpoint({ llmModel: "gemini-2.5-flash" }).url).toBe("https://custom.openrouter.example.com/v1/chat/completions");
    } finally {
      if (savedUrl !== undefined) {
        process.env.OPENROUTER_API_URL = savedUrl;
      } else {
        delete process.env.OPENROUTER_API_URL;
      }
    }
  });

  it("routes the Red Team to Gemini/Mistral via redTeamLlmModel through OpenRouter", () => {
    const gem = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini", redTeamLlmModel: "gemini-2.5-flash" }, "local", "https://openrouter.ai/v1/responses", "red");
    expect(gem.provider).toBe("openrouter");
    expect(gem.model).toBe("google/gemini-2.5-flash");
    const mis = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini", redTeamLlmModel: "mistral-large-2512" }, "local", "https://openrouter.ai/v1/responses", "red");
    expect(mis.provider).toBe("openrouter");
    expect(mis.model).toBe("mistralai/mistral-large-2512");
  });

  it("routes claude-* (Green Team) to OpenRouter with prefix anthropic/", () => {
    for (const model of ["anthropic/claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "Claude-Haiku-4-5-20251001"]) {
      const endpoint = resolveLlmEndpoint({ llmModel: model });
      expect(endpoint.provider).toBe("openrouter");
      expect(endpoint.url).toBe(getExpectedUrl());
      expect(endpoint.transport).toBe("chat-completions");
      const bareName = model.includes("/") ? model.split("/").pop()! : model;
      expect(endpoint.model).toBe(`anthropic/${bareName}`);
    }
  });

  it("routes the Red Team to Claude via redTeamLlmModel through OpenRouter", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "anthropic/claude-opus-4-8" },
      "local",
      "https://openrouter.ai/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("anthropic/claude-opus-4-8");
    expect(endpoint.transport).toBe("chat-completions");

    // Green role with the same policy still resolves to OpenRouter as well — the two teams are independent.
    const green = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini", redTeamLlmModel: "anthropic/claude-opus-4-8" }, "local");
    expect(green.provider).toBe("openrouter");
    expect(green.model).toBe("openai/gpt-5.4-mini");
  });
});

describe("modelCredentialService (universal-OpenRouter eligibility/save-gate)", () => {
  it("keys on the OpenRouter credential in production, the native family under test", async () => {
    const { modelCredentialService } = await import("../src/lib/llm-provider");
    // Production: EVERY model is served through the OpenRouter credential, so eligibility and the
    // policy save-gate must require the OpenRouter key — not an unused native key (Codex #1703).
    vi.stubEnv("NODE_ENV", "production");
    expect(modelCredentialService("gpt-5.4-mini")).toBe("openrouter");
    expect(modelCredentialService("claude-opus-4-8")).toBe("openrouter");
    expect(modelCredentialService("x-ai/grok-4.3")).toBe("openrouter");
    vi.unstubAllEnvs();
    // Test mode mirrors resolveLlmEndpoint's shim so native-key fixtures keep resolving.
    expect(modelCredentialService("gpt-5.4-mini")).toBe("openai");
    expect(modelCredentialService("claude-opus-4-8")).toBe("anthropic");
    expect(modelCredentialService("grok-4.3")).toBe("xai");
  });
});

/**
 * Tests for resolveLlmEndpoint — provider routing based on model name.
 * All tests run entirely offline (no real API key or network call required).
 */

import { beforeAll, describe, expect, it } from "vitest";
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

  it("routes grok-4.3 to xAI with chat-completions transport", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.3" });
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toContain("api.x.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("grok-4.3");
  });

  it("routes grok-build-0.1 to xAI (case-insensitive prefix match)", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-build-0.1" });
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toContain("api.x.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("grok-build-0.1");
  });

  it("routes gpt-5.4-mini to OpenAI", () => {
    const savedUrl = process.env.OPENAI_API_URL;
    delete process.env.OPENAI_API_URL;
    try {
      const endpoint = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini" });
      expect(endpoint.provider).toBe("openai");
      expect(endpoint.url).toContain("api.openai.com");
      expect(endpoint.model).toBe("gpt-5.4-mini");
    } finally {
      if (savedUrl !== undefined) process.env.OPENAI_API_URL = savedUrl;
    }
  });

  it("routes the Red Team through redTeamLlmModel when configured", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "grok-4.3" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.model).toBe("grok-4.3");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls Red Team back to the Green model when no red override is set AND no cross-family credential exists", () => {
    // No Anthropic credential configured in this DB/env, so the cross-family default (below) cannot
    // be honored — same-family fallback preserves today's behavior for a single-provider setup.
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("openai");
    expect(endpoint.model).toBe("gpt-5.4-mini");
  });

  it("defaults the Red Team to a cross-family model when no override is set but a cross-family credential IS available", async () => {
    // Composite review B/medium/S: "Green and Red resolve to the same model by default ... one
    // greedy same-family Bear surfaces one failure mode." When the owner configures an Anthropic key
    // (without setting redTeamLlmModel explicitly), an OpenAI Bull's Bear now defaults to Claude
    // instead of silently echoing gpt-5.4-mini.
    const { upsertUserApiKey, deleteUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("cross-family-user", "anthropic", "test-anthropic-key", "test fixture");
    try {
      const endpoint = resolveLlmEndpoint(
        { llmModel: "gpt-5.4-mini" },
        "cross-family-user",
        "https://api.openai.com/v1/responses",
        "red"
      );
      expect(endpoint.provider).toBe("anthropic");
      expect(endpoint.model).toBe("claude-haiku-4-5");

      // Green role with the same policy is unaffected — only the red role's default changes.
      const green = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini" }, "cross-family-user");
      expect(green.provider).toBe("openai");
    } finally {
      deleteUserApiKey("cross-family-user", "anthropic");
    }
  });

  it("cross-family default for an Anthropic Bull is a cheap OpenAI reviewer", async () => {
    const { upsertUserApiKey, deleteUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("cross-family-user-2", "openai", "test-openai-key", "test fixture");
    try {
      const endpoint = resolveLlmEndpoint(
        { llmModel: "claude-opus-4-8" },
        "cross-family-user-2",
        "https://api.openai.com/v1/responses",
        "red"
      );
      expect(endpoint.provider).toBe("openai");
      expect(endpoint.model).toBe("gpt-5.4-mini");
    } finally {
      deleteUserApiKey("cross-family-user-2", "openai");
    }
  });

  it("routes empty/no policy to OpenAI (default model unchanged)", () => {
    const savedUrl = process.env.OPENAI_API_URL;
    delete process.env.OPENAI_API_URL;
    try {
      const endpoint = resolveLlmEndpoint({});
      expect(endpoint.provider).toBe("openai");
    } finally {
      if (savedUrl !== undefined) process.env.OPENAI_API_URL = savedUrl;
    }
  });

  it("uses XAI_API_URL override when set", () => {
    process.env.XAI_API_URL = "https://custom.xai.example.com/v1/chat/completions";
    try {
      const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.3" });
      expect(endpoint.url).toBe("https://custom.xai.example.com/v1/chat/completions");
    } finally {
      delete process.env.XAI_API_URL;
    }
  });

  it("routes gemini-* to Google (Gemini) via OpenAI-compatible chat-completions", () => {
    const savedUrl = process.env.GEMINI_API_URL;
    delete process.env.GEMINI_API_URL;
    try {
      const endpoint = resolveLlmEndpoint({ llmModel: "gemini-2.5-flash" });
      expect(endpoint.provider).toBe("gemini");
      expect(endpoint.url).toContain("generativelanguage.googleapis.com");
      expect(endpoint.transport).toBe("chat-completions");
      expect(endpoint.model).toBe("gemini-2.5-flash");
    } finally {
      if (savedUrl !== undefined) process.env.GEMINI_API_URL = savedUrl;
    }
  });

  it("routes mistral-* (and ministral/codestral) to Mistral", () => {
    const savedUrl = process.env.MISTRAL_API_URL;
    delete process.env.MISTRAL_API_URL;
    try {
      for (const model of ["mistral-large-2512", "ministral-3b-latest", "codestral-latest"]) {
        const endpoint = resolveLlmEndpoint({ llmModel: model });
        expect(endpoint.provider).toBe("mistral");
        expect(endpoint.url).toContain("api.mistral.ai");
        expect(endpoint.transport).toBe("chat-completions");
        expect(endpoint.model).toBe(model);
      }
    } finally {
      if (savedUrl !== undefined) process.env.MISTRAL_API_URL = savedUrl;
    }
  });

  it("honors GEMINI_API_URL / MISTRAL_API_URL overrides", () => {
    process.env.GEMINI_API_URL = "https://custom.gemini.example.com/v1/chat/completions";
    process.env.MISTRAL_API_URL = "https://custom.mistral.example.com/v1/chat/completions";
    try {
      expect(resolveLlmEndpoint({ llmModel: "gemini-2.5-flash" }).url).toBe("https://custom.gemini.example.com/v1/chat/completions");
      expect(resolveLlmEndpoint({ llmModel: "mistral-large-2512" }).url).toBe("https://custom.mistral.example.com/v1/chat/completions");
    } finally {
      delete process.env.GEMINI_API_URL;
      delete process.env.MISTRAL_API_URL;
    }
  });

  it("routes the Red Team to Gemini/Mistral via redTeamLlmModel", () => {
    const gem = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini", redTeamLlmModel: "gemini-2.5-flash" }, "local", "https://api.openai.com/v1/responses", "red");
    expect(gem.provider).toBe("gemini");
    const mis = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini", redTeamLlmModel: "mistral-large-2512" }, "local", "https://api.openai.com/v1/responses", "red");
    expect(mis.provider).toBe("mistral");
  });

  it("routes claude-* (Green Team) to Anthropic with the anthropic-messages transport", () => {
    const savedUrl = process.env.ANTHROPIC_API_URL;
    delete process.env.ANTHROPIC_API_URL;
    try {
      for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "Claude-Haiku-4-5-20251001"]) {
        const endpoint = resolveLlmEndpoint({ llmModel: model });
        expect(endpoint.provider).toBe("anthropic");
        expect(endpoint.url).toContain("api.anthropic.com");
        expect(endpoint.url).toContain("/v1/messages");
        expect(endpoint.transport).toBe("anthropic-messages");
        expect(endpoint.model).toBe(model);
      }
    } finally {
      if (savedUrl !== undefined) process.env.ANTHROPIC_API_URL = savedUrl;
    }
  });

  it("routes the Red Team to Claude via redTeamLlmModel (Green stays OpenAI)", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "claude-opus-4-8" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("anthropic");
    expect(endpoint.model).toBe("claude-opus-4-8");
    expect(endpoint.transport).toBe("anthropic-messages");

    // Green role with the same policy still resolves to OpenAI — the two teams are independent.
    const green = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini", redTeamLlmModel: "claude-opus-4-8" }, "local");
    expect(green.provider).toBe("openai");
  });

  it("honors the ANTHROPIC_API_URL override", () => {
    process.env.ANTHROPIC_API_URL = "https://custom.anthropic.example.com/v1/messages";
    try {
      expect(resolveLlmEndpoint({ llmModel: "claude-opus-4-8" }).url).toBe("https://custom.anthropic.example.com/v1/messages");
    } finally {
      delete process.env.ANTHROPIC_API_URL;
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveLlmCredential: vi.fn(),
  isOverLlmBudget: vi.fn(() => true)
}));

vi.mock("@/lib/request-user", () => ({ resolveRequestUserId: () => "tenant-chat" }));
vi.mock("@/lib/db", () => ({
  resolveLlmCredential: mocks.resolveLlmCredential,
  getPolicy: () => ({})
}));
vi.mock("@/lib/llm-route", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm-route")>()),
  llmRouteFor: () => "openrouter" as const
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: () => null,
  RATE_LIMITS: { chat: { limit: 10, windowMs: 60_000 } }
}));
vi.mock("@/lib/llm-budget", () => ({ isOverLlmBudget: mocks.isOverLlmBudget }));
vi.mock("@/lib/chat/turn-registry", () => ({
  registerChatTurn: () => ({ controller: new AbortController() }),
  releaseChatTurn: vi.fn()
}));
vi.mock("@/lib/chat/orchestrator", () => ({
  buildProductionDeps: vi.fn(),
  makeOrchestrator: vi.fn()
}));
vi.mock("@/lib/chat/llm", () => ({
  AnthropicLLM: class {},
  OpenAILLM: class {},
  MockLLM: class {},
  chatProviderForModel: (model: string) => model.startsWith("claude") ? "anthropic" : "openai",
  getLLM: vi.fn(),
  llmForModel: vi.fn()
}));

import { POST } from "../app/api/chat/route";

function request(model?: string): Request {
  return new Request("https://socratictrade.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello", ...(model ? { model } : {}) })
  });
}

function credentials(available: Partial<Record<string, boolean>>) {
  mocks.resolveLlmCredential.mockImplementation((service: string, userId: string) => ({
    key: available[service] ? `key-${service}` : undefined,
    source: "user",
    keyRef: `${userId}:${service}`
  }));
}

describe("POST /api/chat model credential gate", () => {
  beforeEach(() => {
    mocks.resolveLlmCredential.mockReset();
    mocks.isOverLlmBudget.mockReturnValue(true);
  });

  it("requires OpenRouter for Astra Pro even when an OpenAI key exists", async () => {
    credentials({ openai: true, openrouter: false });

    const response = await POST(request("gpt-6-astra-pro"));

    expect(response.status).toBe(412);
    expect(mocks.resolveLlmCredential).toHaveBeenLastCalledWith("openrouter", "tenant-chat");
  });

  it("accepts Astra Pro when its required OpenRouter key exists", async () => {
    credentials({ openai: false, openrouter: true });

    const response = await POST(request("gpt-6-astra-pro"));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "llm_budget_exceeded" });
    expect(mocks.resolveLlmCredential).toHaveBeenLastCalledWith("openrouter", "tenant-chat");
  });

  it("accepts MiniMax through an OpenRouter key", async () => {
    credentials({ minimax: false, openrouter: true });

    const response = await POST(request("minimax-m3"));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "llm_budget_exceeded" });
    expect(mocks.resolveLlmCredential).toHaveBeenCalledWith("openrouter", "tenant-chat");
  });

  it("falls back to a native MiniMax key when OpenRouter is unavailable", async () => {
    credentials({ minimax: true, openrouter: false });

    const response = await POST(request("minimax-m3"));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "llm_budget_exceeded" });
    expect(mocks.resolveLlmCredential).toHaveBeenCalledWith("openrouter", "tenant-chat");
    expect(mocks.resolveLlmCredential).toHaveBeenLastCalledWith("minimax", "tenant-chat");
  });

  it("requires OpenRouter for an explicitly OpenRouter-routed MiniMax id", async () => {
    credentials({ minimax: true, openrouter: false });

    const response = await POST(request("openrouter/minimax/minimax-m3"));

    expect(response.status).toBe(412);
    expect(mocks.resolveLlmCredential).toHaveBeenLastCalledWith("openrouter", "tenant-chat");
  });

  it("preserves the fail-loud response when neither route has a key", async () => {
    credentials({ minimax: false, openrouter: false });

    const response = await POST(request("minimax-m3"));

    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({ error: "llm_credential_required" });
  });

  it("checks OpenRouter for the explicit operator OpenRouter path", async () => {
    const savedProvider = process.env.CHAT_LLM;
    const savedModel = process.env.CHAT_LLM_MODEL;
    process.env.CHAT_LLM = "openrouter";
    process.env.CHAT_LLM_MODEL = "minimax-m3";
    credentials({ openrouter: true });
    try {
      const response = await POST(request());

      expect(response.status).toBe(429);
      expect(mocks.resolveLlmCredential).toHaveBeenLastCalledWith("openrouter", "tenant-chat");
    } finally {
      if (savedProvider === undefined) delete process.env.CHAT_LLM;
      else process.env.CHAT_LLM = savedProvider;
      if (savedModel === undefined) delete process.env.CHAT_LLM_MODEL;
      else process.env.CHAT_LLM_MODEL = savedModel;
    }
  });

  it("checks the tenant MiniMax key for the native MiniMax operator path", async () => {
    const savedProvider = process.env.CHAT_LLM;
    const savedModel = process.env.CHAT_LLM_MODEL;
    process.env.CHAT_LLM = "minimax";
    process.env.CHAT_LLM_MODEL = "minimax-m3";
    credentials({ minimax: true, openrouter: false });
    try {
      const response = await POST(request());

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: "llm_budget_exceeded" });
      expect(mocks.resolveLlmCredential).toHaveBeenLastCalledWith("minimax", "tenant-chat");
      expect(mocks.resolveLlmCredential).not.toHaveBeenCalledWith("openai", "tenant-chat");
    } finally {
      if (savedProvider === undefined) delete process.env.CHAT_LLM;
      else process.env.CHAT_LLM = savedProvider;
      if (savedModel === undefined) delete process.env.CHAT_LLM_MODEL;
      else process.env.CHAT_LLM_MODEL = savedModel;
    }
  });
});

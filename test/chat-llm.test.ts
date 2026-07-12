/**
 * Tests for OpenAILLM (and getLLM provider routing).
 *
 * OpenAILLM uses an injectable transport, so all tests run entirely offline —
 * no real API key or network call is required.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db";
import { AnthropicLLM, chatProviderForModel, getLLM, llmForModel, MockLLM, OpenAILLM } from "../src/lib/chat/llm";
import { buildSystem, DISCLAIMER, SYSTEM_PROMPT } from "../src/lib/chat/prompt";
import type { LlmRunArgs, ToolSchema } from "../src/lib/chat/types";

// Shared LlmRunArgs fixture — minimal but valid.
const noopExecuteTool = async (_name: string, _input: unknown) => ({ ok: true });

const baseArgs: LlmRunArgs = {
  system: "You are a trading assistant.",
  message: "Hello",
  tools: [],
  executeTool: noopExecuteTool
};

// ── OpenAI response shapes ───────────────────────────────────────────────────

/** Build a minimal chat-completions response with a text assistant message. */
function chatResponse(content: string, finishReason = "stop") {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }]
  };
}

/** Build a tool_calls finish response. */
function toolCallResponse(name: string, args: Record<string, unknown>, toolCallId = "tc_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: toolCallId, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: "tool_calls"
      }
    ]
  };
}

// ── OpenAILLM unit tests ─────────────────────────────────────────────────────

describe("OpenAILLM — ChatLLM contract", () => {
  beforeAll(() => {
    // Point DB at a temp file so resolveApiKey doesn't blow up.
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-llm-test-${Date.now()}.db`;
    getDb();
  });

  it("returns text from a plain (no-tool) response", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("Hello from OpenAI!"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const result = await llm.run(baseArgs);

    expect(result.text).toBe("Hello from OpenAI!");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.citations).toHaveLength(0);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("sends system prompt + user message in the messages array", async () => {
    // Capture a snapshot of the messages array at call time (the array is mutated after the call).
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const transport = vi.fn().mockImplementation((body: { messages: Array<{ role: string; content: string }> }) => {
      capturedMessages = body.messages.map((m) => ({ role: m.role, content: m.content }));
      return Promise.resolve(chatResponse("ok"));
    });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    await llm.run({ ...baseArgs, system: "sys-prompt", message: "user-msg" });

    expect(capturedMessages[0]).toMatchObject({ role: "system", content: "sys-prompt" });
    expect(capturedMessages[capturedMessages.length - 1]).toMatchObject({ role: "user", content: "user-msg" });
  });

  it("passes the api key in the second argument to transport", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    const llm = new OpenAILLM("sk-my-key", "gpt-4o-mini", transport);
    await llm.run(baseArgs);

    const apiKey = transport.mock.calls[0][1];
    expect(apiKey).toBe("sk-my-key");
  });

  it("includes OpenAI tools array when tool schemas are provided", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [
      { name: "get_quote", description: "Get a stock quote", input_schema: { type: "object", properties: { symbol: { type: "string" } } } }
    ];
    await llm.run({ ...baseArgs, tools });

    const body = transport.mock.calls[0][0];
    expect(body.tools).toBeDefined();
    expect(body.tools[0].function.name).toBe("get_quote");
    expect(body.tool_choice).toBe("auto");
  });

  it("executes a tool call and appends the result, then returns final text", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("get_quote", { symbol: "AAPL" }))
      .mockResolvedValueOnce(chatResponse("AAPL is at $200."));

    const executeTool = vi.fn().mockResolvedValue({ symbol: "AAPL", price_usd: 200, as_of: "2026-06-21" });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [
      { name: "get_quote", description: "Get a stock quote", input_schema: { type: "object", properties: { symbol: { type: "string" } } } }
    ];
    const result = await llm.run({ ...baseArgs, tools, executeTool });

    expect(executeTool).toHaveBeenCalledWith("get_quote", { symbol: "AAPL" });
    expect(result.text).toBe("AAPL is at $200.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_quote");
    // Two transport calls: first returns tool_calls, second returns final text.
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("emits get_quote citations from tool calls", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("get_quote", { symbol: "TSLA" }))
      .mockResolvedValueOnce(chatResponse("TSLA price noted."));

    const executeTool = vi.fn().mockResolvedValue({ symbol: "TSLA", price_usd: 180, as_of: "2026-06-21T00:00:00Z" });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [{ name: "get_quote", description: "q", input_schema: {} }];
    const result = await llm.run({ ...baseArgs, tools, executeTool });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].source).toBe("get_quote");
    expect(result.citations[0].as_of).toBe("2026-06-21T00:00:00Z");
  });

  it("falls back to DISCLAIMER when the response has no text content", async () => {
    // content is null (tool call only, loop exits)
    const transport = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }]
    });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const result = await llm.run(baseArgs);

    expect(result.text).toBe(DISCLAIMER);
  });

  it("handles a tool-execution error without crashing", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("get_quote", { symbol: "ERR" }))
      .mockResolvedValueOnce(chatResponse("Could not get quote."));

    const executeTool = vi.fn().mockRejectedValue(new Error("network timeout"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [{ name: "get_quote", description: "q", input_schema: {} }];
    const result = await llm.run({ ...baseArgs, tools, executeTool });

    expect(result.toolCalls[0].result).toMatchObject({ error: "TOOL_FAILED", message: "network timeout" });
    expect(result.text).toBe("Could not get quote.");
  });

  it("replays prior turns in the messages array for multi-turn context", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("second reply"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const history = [
      { role: "user" as const, text: "first user message" },
      { role: "assistant" as const, text: "first assistant reply" }
    ];
    await llm.run({ ...baseArgs, message: "second user message", history });

    const body = transport.mock.calls[0][0];
    const msgs: Array<{ role: string; content: string }> = body.messages;
    const roles = msgs.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // Verify ordering: system, then prior user, then prior assistant, then new user.
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs[userMsgs.length - 1].content).toBe("second user message");
  });

  it("drops a leading assistant history turn to satisfy OpenAI alternation requirement", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    // History starting with an assistant turn (edge case during race conditions).
    const history = [{ role: "assistant" as const, text: "stale assistant prefix" }];
    await llm.run({ ...baseArgs, history });

    const body = transport.mock.calls[0][0];
    const msgs: Array<{ role: string; content: string }> = body.messages;
    // After the system message the first non-system role must be user, not assistant.
    const nonSystem = msgs.filter((m) => m.role !== "system");
    expect(nonSystem[0].role).toBe("user");
  });
});

// ── AnthropicLLM prompt-caching unit tests ──────────────────────────────────

describe("AnthropicLLM — prompt-caching cache_control", () => {
  /** Minimal Anthropic-style text response. */
  function anthropicResponse(text: string) {
    return { content: [{ type: "text", text }], stop_reason: "end_turn" };
  }

  it("sends system as an array of content blocks (not a plain string)", async () => {
    let capturedBody: any = null;
    const transport = vi.fn().mockImplementation((body: any) => {
      capturedBody = body;
      return Promise.resolve(anthropicResponse("ok"));
    });
    const llm = new AnthropicLLM("ant-test", "claude-sonnet-4-6", transport);
    await llm.run({ ...baseArgs, system: SYSTEM_PROMPT });

    expect(Array.isArray(capturedBody.system)).toBe(true);
  });

  it("marks the entire system as ephemeral when system equals SYSTEM_PROMPT exactly", async () => {
    let capturedBody: any = null;
    const transport = vi.fn().mockImplementation((body: any) => {
      capturedBody = body;
      return Promise.resolve(anthropicResponse("ok"));
    });
    const llm = new AnthropicLLM("ant-test", "claude-sonnet-4-6", transport);
    await llm.run({ ...baseArgs, system: SYSTEM_PROMPT });

    const systemBlocks: any[] = capturedBody.system;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].text).toBe(SYSTEM_PROMPT);
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("splits stable prefix (ephemeral) and dynamic suffix (uncached) when user memory is present", async () => {
    let capturedBody: any = null;
    const transport = vi.fn().mockImplementation((body: any) => {
      capturedBody = body;
      return Promise.resolve(anthropicResponse("ok"));
    });
    const llm = new AnthropicLLM("ant-test", "claude-sonnet-4-6", transport);
    const systemWithMemory = buildSystem("Hold AAPL long-term.");
    await llm.run({ ...baseArgs, system: systemWithMemory });

    const systemBlocks: any[] = capturedBody.system;
    // Two blocks: stable prefix (cached) + dynamic suffix (not cached).
    expect(systemBlocks).toHaveLength(2);
    expect(systemBlocks[0].text).toBe(SYSTEM_PROMPT);
    expect(systemBlocks[0].cache_control).toEqual({ type: "ephemeral" });
    // Dynamic suffix should NOT have cache_control.
    expect(systemBlocks[1].cache_control).toBeUndefined();
    expect(systemBlocks[1].text).toContain("Hold AAPL long-term.");
  });

  it("sends unrecognised system string as a single uncached block", async () => {
    let capturedBody: any = null;
    const transport = vi.fn().mockImplementation((body: any) => {
      capturedBody = body;
      return Promise.resolve(anthropicResponse("ok"));
    });
    const llm = new AnthropicLLM("ant-test", "claude-sonnet-4-6", transport);
    await llm.run({ ...baseArgs, system: "custom override system prompt" });

    const systemBlocks: any[] = capturedBody.system;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0].text).toBe("custom override system prompt");
    expect(systemBlocks[0].cache_control).toBeUndefined();
  });
});

// ── getLLM provider routing ─────────────────────────────────────────────────

describe("getLLM provider routing", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-llm-routing-${Date.now()}.db`;
    getDb();
  });

  it("returns MockLLM when CHAT_LLM is unset", () => {
    const saved = process.env.CHAT_LLM;
    delete process.env.CHAT_LLM;
    const llm = getLLM();
    expect(llm).toBeInstanceOf(MockLLM);
    if (saved !== undefined) process.env.CHAT_LLM = saved;
  });

  it("returns MockLLM when CHAT_LLM=openai but no key is available", () => {
    const savedLlm = process.env.CHAT_LLM;
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.CHAT_LLM = "openai";
    delete process.env.OPENAI_API_KEY;
    const llm = getLLM();
    expect(llm).toBeInstanceOf(MockLLM);
    process.env.CHAT_LLM = savedLlm;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  });

  it("returns OpenAILLM when CHAT_LLM=openai and OPENAI_API_KEY is set", () => {
    const savedLlm = process.env.CHAT_LLM;
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.CHAT_LLM = "openai";
    process.env.OPENAI_API_KEY = "sk-test-key";
    const llm = getLLM();
    expect(llm).toBeInstanceOf(OpenAILLM);
    process.env.CHAT_LLM = savedLlm;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it("returns AnthropicLLM when CHAT_LLM=anthropic and ANTHROPIC_API_KEY is set", () => {
    const savedLlm = process.env.CHAT_LLM;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.CHAT_LLM = "anthropic";
    process.env.ANTHROPIC_API_KEY = "ant-test-key";
    const llm = getLLM();
    expect(llm).toBeInstanceOf(AnthropicLLM);
    process.env.CHAT_LLM = savedLlm;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });
});

// ── llmForModel: model-name → provider routing across all five providers ─────

describe("chatProviderForModel — model name → provider", () => {
  it("derives the provider from the model-name prefix", () => {
    expect(chatProviderForModel("claude-haiku-4-5")).toBe("anthropic");
    expect(chatProviderForModel("grok-4.3")).toBe("xai");
    expect(chatProviderForModel("gemini-2.5-flash")).toBe("gemini");
    expect(chatProviderForModel("mistral-large-2512")).toBe("mistral");
    expect(chatProviderForModel("ministral-3b-latest")).toBe("mistral");
    expect(chatProviderForModel("deepseek-v4-flash")).toBe("deepseek");
    expect(chatProviderForModel("deepseek-v4-pro")).toBe("deepseek");
    expect(chatProviderForModel("gpt-5.4-mini")).toBe("openai");
    expect(chatProviderForModel("o4-mini")).toBe("openai");
  });
});

describe("llmForModel — multi-provider routing", () => {
  // Every LLM provider key; the helper below presents exactly one (or none) so we can prove the
  // model routes to its own provider and never silently borrows a different provider's key.
  const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY"] as const;

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-llm-model-routing-${Date.now()}.db`;
    process.env.LLM_OPERATOR_FALLBACK = "on"; // env key serves a keyless user (operator-funded failover)
    getDb();
  });

  function withOnlyKey(present: (typeof KEYS)[number] | null, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    if (present) process.env[present] = `key-for-${present}`;
    try {
      fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
  }

  it("returns MockLLM for an empty or 'mock' model", () => {
    expect(llmForModel("", "u_mock")).toBeInstanceOf(MockLLM);
    expect(llmForModel("mock", "u_mock")).toBeInstanceOf(MockLLM);
  });

  it("routes claude-* to AnthropicLLM with an Anthropic key", () => {
    withOnlyKey("ANTHROPIC_API_KEY", () => {
      expect(llmForModel("claude-haiku-4-5", "u_anthropic")).toBeInstanceOf(AnthropicLLM);
    });
  });

  it("routes gpt-*/grok-*/gemini-*/mistral-* to OpenAILLM with that provider's key", () => {
    withOnlyKey("OPENAI_API_KEY", () => expect(llmForModel("gpt-5.4-mini", "u_openai")).toBeInstanceOf(OpenAILLM));
    withOnlyKey("XAI_API_KEY", () => expect(llmForModel("grok-4.3", "u_xai")).toBeInstanceOf(OpenAILLM));
    withOnlyKey("GEMINI_API_KEY", () => expect(llmForModel("gemini-2.5-flash", "u_gemini")).toBeInstanceOf(OpenAILLM));
    withOnlyKey("MISTRAL_API_KEY", () => expect(llmForModel("mistral-medium-3-5", "u_mistral")).toBeInstanceOf(OpenAILLM));
    withOnlyKey("DEEPSEEK_API_KEY", () => expect(llmForModel("deepseek-v4-flash", "u_deepseek")).toBeInstanceOf(OpenAILLM));
  });

  it("does NOT borrow another provider's key — a non-OpenAI model with only an OpenAI key is MockLLM", () => {
    withOnlyKey("OPENAI_API_KEY", () => {
      expect(llmForModel("gemini-2.5-flash", "u_gem2")).toBeInstanceOf(MockLLM);
      expect(llmForModel("mistral-large-2512", "u_mis2")).toBeInstanceOf(MockLLM);
      expect(llmForModel("claude-sonnet-4-6", "u_ant2")).toBeInstanceOf(MockLLM);
      expect(llmForModel("grok-4.3", "u_xai2")).toBeInstanceOf(MockLLM);
    });
  });

  it("returns MockLLM when no provider key is available at all", () => {
    withOnlyKey(null, () => {
      expect(llmForModel("gpt-5.4-mini", "u_none")).toBeInstanceOf(MockLLM);
      expect(llmForModel("gemini-2.5-flash", "u_none")).toBeInstanceOf(MockLLM);
    });
  });
});

// ── MockLLM labels every answer ──────────────────────────────────────────────

describe("MockLLM — labels every reply as a mock response", () => {
  it("prefixes 'Mock Response: ' on a plain chat reply (and keeps the disclaimer)", async () => {
    const res = await new MockLLM().run({ system: "", message: "hello there", tools: [], executeTool: async () => ({ ok: true }) });
    expect(res.text.startsWith("Mock Response: ")).toBe(true);
    expect(res.text).toContain("not personalized financial advice"); // disclaimer still present
  });

  it("labels a tool-backed answer exactly once (no double prefix)", async () => {
    const res = await new MockLLM().run({
      system: "",
      message: "what's on my watchlist?",
      tools: [],
      executeTool: async (name: string) => (name === "list_watchlist" ? { watchlist: [] } : { ok: true })
    });
    expect(res.text.startsWith("Mock Response: ")).toBe(true);
    expect(res.text.indexOf("Mock Response: ")).toBe(res.text.lastIndexOf("Mock Response: "));
  });
});

// ── Token-cap parameter: max_completion_tokens for OpenAI reasoning models ────

describe("OpenAILLM — token-cap param by model/provider", () => {
  it("sends max_completion_tokens (not max_tokens) for OpenAI reasoning models", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    await new OpenAILLM("sk-test", "gpt-5.4-mini", transport, {}, "openai").run(baseArgs);
    const body = transport.mock.calls[0][0];
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeUndefined();
  });

  it("sends max_tokens for OpenAI classic (non-reasoning) models", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    await new OpenAILLM("sk-test", "gpt-4o-mini", transport).run(baseArgs);
    const body = transport.mock.calls[0][0];
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("keeps max_tokens for OpenAI-compatible providers (never sends the OpenAI-only param)", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    await new OpenAILLM("sk-test", "gemini-2.5-flash", transport, {}, "gemini").run(baseArgs);
    const body = transport.mock.calls[0][0];
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

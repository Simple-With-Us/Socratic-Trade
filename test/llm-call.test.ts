/**
 * Tests for the shared LLM request builder/extractor (llm-call.ts) — the layer that lets Claude be a
 * first-class Green/Red Team model alongside the OpenAI-compatible providers. All offline; no network.
 */

import { describe, expect, it } from "vitest";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText } from "../src/lib/llm-call";

const SCHEMA = {
  name: "trade_proposals",
  description: "proposals",
  schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }
};

describe("buildLlmRequestBody", () => {
  it("OpenAI chat-completions: strict json_schema + max_completion_tokens (reasoning model)", () => {
    const body = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "gpt-5.4-mini", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "trade_proposals", strict: true, schema: SCHEMA.schema } });
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(1500);
    // No top-level Anthropic-only fields leak in.
    expect(body.system).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it("DeepSeek chat-completions: downgrades a schema to bare json_object", () => {
    const body = buildLlmRequestBody(
      { provider: "deepseek", transport: "chat-completions" },
      { model: "deepseek-v4-flash", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("OpenAI responses: STRICT json_schema under text.format", () => {
    const body = buildLlmRequestBody(
      { provider: "openai", transport: "responses" },
      { model: "gpt-5.4-mini", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.input[0]).toEqual({ role: "system", content: "sys" });
    // strict:true — without it the Responses API treats the schema as advisory (Codex review, PR #301).
    expect(body.text).toEqual({ format: { type: "json_schema", name: "trade_proposals", strict: true, schema: SCHEMA.schema } });
  });

  it("Anthropic: system field + forced tool-use for the schema, max_tokens set, no response_format", () => {
    const body = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { model: "claude-opus-4-8", systemPrompt: "sys", userContent: "{\"a\":1}", schema: SCHEMA, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(body.model).toBe("claude-opus-4-8");
    // Prompt caching (Chat A item 3): system is a single ephemeral cache block, not a bare string.
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([{ role: "user", content: "{\"a\":1}" }]);
    expect(body.tools).toEqual([{ name: "trade_proposals", description: "proposals", input_schema: SCHEMA.schema }]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "trade_proposals" });
    expect(body.max_tokens).toBeGreaterThanOrEqual(1500);
    // OpenAI-only fields must never appear on an Anthropic body.
    expect(body.response_format).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("Anthropic adaptive-thinking models get adaptive thinking config, not temperature", () => {
    const body = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      {
        model: "claude-opus-4-8",
        systemPrompt: "sys",
        userContent: "{}",
        schema: SCHEMA,
        maxOutputTokens: 1500,
        reasoningEffort: "xhigh"
      }
    ) as Record<string, any>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body.temperature).toBeUndefined();
  });

  it("OpenAI-compatible providers get their own reasoning_effort values", () => {
    const gemini = buildLlmRequestBody(
      { provider: "gemini", transport: "chat-completions" },
      { model: "gemini-2.5-flash", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "none" }
    ) as Record<string, any>;
    expect(gemini.reasoning_effort).toBe("none");
    expect(gemini.reasoning).toBeUndefined();

    const xai = buildLlmRequestBody(
      { provider: "xai", transport: "chat-completions" },
      { model: "grok-4.3", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "high" }
    ) as Record<string, any>;
    expect(xai.reasoning_effort).toBe("high");

    const mistral = buildLlmRequestBody(
      { provider: "mistral", transport: "chat-completions" },
      { model: "mistral-large-2512", systemPrompt: "sys", userContent: "{}", schema: SCHEMA, maxOutputTokens: 1500, reasoningEffort: "xhigh" }
    ) as Record<string, any>;
    expect(mistral.reasoning_effort).toBe("xhigh");
    expect(mistral.prompt_mode).toBe("reasoning");
  });

  it("Anthropic auth headers include the prompt-caching beta; OpenAI-compatible unchanged (item 3)", () => {
    const anthropic = llmAuthHeaders({ provider: "anthropic", key: "sk-ant" });
    expect(anthropic["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(anthropic["x-api-key"]).toBe("sk-ant");
    expect(anthropic["anthropic-version"]).toBe("2023-06-01");
    // OpenAI-compatible transport is untouched: Bearer auth, no anthropic beta header.
    const openai = llmAuthHeaders({ provider: "openai", key: "sk" });
    expect(openai["anthropic-beta"]).toBeUndefined();
    expect(openai.authorization).toBe("Bearer sk");
  });

  it("openAiJsonObject keeps OpenAI on json_object but Anthropic still uses the forced tool", () => {
    const oa = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "gpt-4o-mini", systemPrompt: "s", userContent: "{}", schema: SCHEMA, openAiJsonObject: true, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(oa.response_format).toEqual({ type: "json_object" });

    const an = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { model: "claude-haiku-4-5", systemPrompt: "s", userContent: "{}", schema: SCHEMA, openAiJsonObject: true, maxOutputTokens: 1500 }
    ) as Record<string, any>;
    expect(an.tool_choice).toEqual({ type: "tool", name: "trade_proposals" });
  });

  it("no schema → free-text output (no response_format / tools)", () => {
    const oa = buildLlmRequestBody(
      { provider: "openai", transport: "chat-completions" },
      { model: "gpt-4o-mini", systemPrompt: "s", userContent: "hi", maxOutputTokens: 500 }
    ) as Record<string, any>;
    expect(oa.response_format).toBeUndefined();

    const an = buildLlmRequestBody(
      { provider: "anthropic", transport: "anthropic-messages" },
      { model: "claude-haiku-4-5", systemPrompt: "s", userContent: "hi", maxOutputTokens: 500 }
    ) as Record<string, any>;
    expect(an.tools).toBeUndefined();
    expect(an.tool_choice).toBeUndefined();
  });
});

describe("llmAuthHeaders", () => {
  it("Anthropic uses x-api-key + anthropic-version, not Bearer", () => {
    const h = llmAuthHeaders({ provider: "anthropic", key: "sk-ant-123" });
    expect(h["x-api-key"]).toBe("sk-ant-123");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h.authorization).toBeUndefined();
  });

  it("OpenAI-compatible providers use Bearer auth", () => {
    for (const provider of ["openai", "xai", "gemini", "mistral", "deepseek"] as const) {
      const h = llmAuthHeaders({ provider, key: "k" });
      expect(h.authorization).toBe("Bearer k");
      expect(h["x-api-key"]).toBeUndefined();
    }
  });
});

describe("extractLlmText", () => {
  it("OpenAI chat-completions content", () => {
    expect(extractLlmText({ choices: [{ message: { content: "{\"ok\":true}" } }] })).toBe("{\"ok\":true}");
  });

  it("OpenAI responses output_text", () => {
    expect(extractLlmText({ output_text: "hello" })).toBe("hello");
  });

  it("Anthropic tool_use input is re-serialized to JSON", () => {
    const payload = { content: [{ type: "tool_use", name: "trade_proposals", input: { ok: true, n: 3 } }] };
    expect(JSON.parse(extractLlmText(payload)!)).toEqual({ ok: true, n: 3 });
  });

  it("Anthropic text blocks are concatenated when there is no tool_use", () => {
    const payload = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(extractLlmText(payload)).toBe("ab");
  });

  it("returns undefined for an empty/unknown payload", () => {
    expect(extractLlmText(undefined)).toBeUndefined();
    expect(extractLlmText({})).toBeUndefined();
  });
});

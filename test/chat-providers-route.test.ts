/**
 * GET /api/chat/providers — per-provider key availability for the Assistant model picker.
 * Returns booleans only (never the key). Availability mirrors resolveLlmCredential (user key OR
 * operator failover), the same check llmForModel uses.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-chat-providers-${randomUUID()}.db`)}`;
});

afterEach(() => vi.unstubAllEnvs());

const LLM_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY"];

async function callRoute(): Promise<Record<string, boolean>> {
  const { getDb } = await import("../src/lib/db");
  getDb();
  const { GET } = await import("../app/api/chat/providers/route");
  const res = await GET(new Request("http://localhost/api/chat/providers"));
  const body = (await res.json()) as { providers: Record<string, boolean> };
  return body.providers;
}

describe("GET /api/chat/providers", () => {
  it("marks every provider available when its key resolves (operator failover on)", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "on");
    for (const k of LLM_ENV) vi.stubEnv(k, "live-key");
    expect(await callRoute()).toMatchObject({ openai: true, anthropic: true, xai: true, gemini: true, mistral: true, deepseek: true });
  });

  it("marks providers unavailable when no key resolves (failover off, no stored keys)", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
    for (const k of LLM_ENV) vi.stubEnv(k, "");
    expect(await callRoute()).toMatchObject({ openai: false, anthropic: false, xai: false, gemini: false, mistral: false, deepseek: false });
  });

  it("reports providers independently (only the keyed one is available)", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "on");
    for (const k of LLM_ENV) vi.stubEnv(k, "");
    vi.stubEnv("GEMINI_API_KEY", "live-key");
    const providers = await callRoute();
    expect(providers.gemini).toBe(true);
    expect(providers.openai).toBe(false);
    expect(providers.mistral).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { detectLlmTruncation } from "../src/lib/llm-call";

// Item 5 (Chat A): a Bull answer that hits the output-token cap truncates its JSON, fails to parse,
// and yields zero proposals. That must be DISTINGUISHED from a genuine "do nothing" — never a silent
// no-op.

describe("detectLlmTruncation (Chat A item 5)", () => {
  it("detects an OpenAI chat-completions finish_reason=length", () => {
    expect(detectLlmTruncation({ choices: [{ finish_reason: "length", message: { content: "{" } }] })).toBe(true);
  });
  it("detects an Anthropic stop_reason=max_tokens", () => {
    expect(detectLlmTruncation({ stop_reason: "max_tokens" })).toBe(true);
  });
  it("detects the OpenAI responses API incomplete/max_output_tokens shape", () => {
    expect(detectLlmTruncation({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toBe(true);
    expect(detectLlmTruncation({ output: [{ status: "incomplete" }] })).toBe(true);
  });
  it("returns false for a complete response or non-object input", () => {
    expect(detectLlmTruncation({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] })).toBe(false);
    expect(detectLlmTruncation({ stop_reason: "end_turn" })).toBe(false);
    expect(detectLlmTruncation({ status: "completed" })).toBe(false);
    expect(detectLlmTruncation(null)).toBe(false);
    expect(detectLlmTruncation("not-an-object")).toBe(false);
  });
});

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-bull-trunc-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Bull truncation is not a silent no-op (Chat A item 5)", () => {
  it("records a strategy_bull_truncated audit + step reason when the Bull response hits the cap", async () => {
    // vi.stubEnv so afterEach(vi.unstubAllEnvs) restores these — a leaked OPENROUTER_API_URL would break
    // other files' Bull-body assertions when vitest shares a process across test files.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    // chat-completions transport so the mock can return a finish_reason=length truncation signal.
    vi.stubEnv("OPENROUTER_API_URL", "https://openrouter.ai/v1/chat/completions");
    let openAiCalls = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        openAiCalls += 1;
        if (openAiCalls === 1) {
          // Truncated Bull: finish_reason "length" with cut-off, unparseable JSON content.
          return new Response(
            JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"proposals":[{"symbol":"AAPL","sid' } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // Any later call (e.g. the Bear reviewing an empty set) returns a clean empty result.
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"proposals":[]}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Truncation Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    // The run completes (a truncated Bull is not a hard failure) but with zero proposals...
    expect(result.status).toBe("completed");
    // ...and the truncation is recorded distinctly, not swallowed as a silent no-op.
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).toContain("strategy_bull_truncated");
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.reason ?? "").toMatch(/truncat/i);
  }, 30_000);
});


describe("MiniMax empty reasoning output", () => {
  async function setupMiniMax() {
    const db = await import("../src/lib/db");
    const { setUserSetting } = await import("../src/lib/db-settings");
    db.upsertUserApiKey("local", "minimax", "test-minimax-key", "fixture");
    setUserSetting("local", "llm_route_minimax", "native");
    const accountId = randomUUID();
    db.upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "MiniMax truncation", isActive: true });
    db.setActiveConnectedAccount(accountId);
    db.setPolicy({ ...DEFAULT_POLICY, systemState: "active", llmModel: "minimax-m3", llmReasoningEffort: "medium", includedIndices: [], additionalSymbols: ["AAPL"], strategyAuthority: "decide" });
    return db;
  }

  function mockMiniMax(outcome: "recover" | "exhaust" | "empty-not-at-cap" | "usage-only") {
    const caps: number[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("api.minimax.io")) {
        const body = JSON.parse(String(init?.body));
        // Post-mortem is not a Green Team generation.
        if (!(body.max_completion_tokens >= 8000)) {
          return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }), { headers: { "content-type": "application/json" } });
        }
        caps.push(body.max_completion_tokens);
        const recovered = outcome === "recover" && caps.length === 2;
        const atCap = outcome !== "empty-not-at-cap";
        return new Response(JSON.stringify({ choices: [{ ...(outcome === "usage-only" ? {} : { finish_reason: recovered || !atCap ? "stop" : "length" }), message: { content: recovered ? '{"proposals":[]}' : "" } }], usage: { prompt_tokens: 48_821, completion_tokens: recovered ? 100 : atCap ? body.max_completion_tokens : 1 } }), { headers: { "content-type": "application/json" } });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    return caps;
  }

  it("retries once at 16000 and keeps the original raw length receipt after recovery", async () => {
    const db = await setupMiniMax();
    const caps = mockMiniMax("recover");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(caps).toEqual([8000, 16000]);
    expect(result.status).toBe("completed");
    const bull = result.llmSteps?.find((s) => s.step === "bull");
    expect(bull?.responseAttempts).toEqual([
      expect.objectContaining({ finishReason: "length", truncated: true, wireOutputCap: 8000, completionTokens: 8000 }),
      expect.objectContaining({ finishReason: "stop", truncated: false, wireOutputCap: 16000, completionTokens: 100 })
    ]);
    const persisted = db.listAudit(5000).filter((e) => (e.payload as { runId?: string }).runId === result.runId && e.kind === "llm_step");
    expect(persisted.some((e) => (e.payload as { responseAttempts?: unknown[] }).responseAttempts?.length === 2)).toBe(true);
    const firstTruncated = persisted.find((e) => (e.payload as { finishReason?: string }).finishReason === "length");
    expect(firstTruncated?.payload).toMatchObject({ status: "failed", model: "MiniMax-M3" });
    expect(db.listAudit(5000).filter((e) => (e.payload as { runId?: string }).runId === result.runId && e.kind === "strategy_llm_failover")).toHaveLength(0);
  }, 30_000);

  it.each(["exhaust", "usage-only"] as const)("fails explicitly after the bounded retry (%s)", async (outcome) => {
    await setupMiniMax();
    const caps = mockMiniMax(outcome);
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(caps).toEqual([8000, 16000]);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/empty content after output truncation at the 16000-token cap/);
    expect(result.summary).not.toMatch(/Failover chain exhausted/);
    expect(result.llmSteps?.find((s) => s.step === "bull")).toMatchObject({ truncated: true, wireOutputCap: 16000, completionTokens: 16000 });
    expect(result.llmSteps?.find((s) => s.step === "bull")?.responseAttempts).toHaveLength(2);
  }, 30_000);

  it("does not retry ordinary empty content below the cap", async () => {
    await setupMiniMax();
    const caps = mockMiniMax("empty-not-at-cap");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(caps).toEqual([8000]);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Empty response returned from LLM API");
    expect(result.llmSteps?.find((s) => s.step === "bull")).toMatchObject({ finishReason: "stop", truncated: false });
  }, 30_000);

  it("records one per-hop event when the exhausted retry moves to the configured fallback", async () => {
    const db = await setupMiniMax();
    db.upsertUserApiKey("local", "openrouter", "test-openrouter-key", "fixture");
    db.setPolicy({ ...db.getPolicy("local"), llmFallbackModels: ["openrouter/google/gemini-2.5-flash"] });
    const { resolveLlmEndpoint } = await import("../src/lib/llm-provider");
    const fallback = resolveLlmEndpoint({ ...db.getPolicy("local"), llmModel: "openrouter/google/gemini-2.5-flash" });
    const caps = mockMiniMax("exhaust");
    const miniMaxFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("openrouter.ai")) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"proposals":[]}' } }] }), { headers: { "content-type": "application/json" } });
      }
      return miniMaxFetch(url, init);
    });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(caps).toEqual([8000, 16000]);
    expect(result.status).toBe("completed");
    const hops = db.listAudit(5000).filter((e) => (e.payload as { runId?: string }).runId === result.runId && e.kind === "strategy_llm_failover");
    expect(hops).toHaveLength(1);
    expect(hops[0].payload).toMatchObject({ fromModel: "MiniMax-M3", fromProvider: "minimax", toModel: fallback.model, toProvider: fallback.provider, reason: "empty_truncated_response", truncated: true, wireOutputCap: 16000 });
    const step = result.llmSteps?.find((s) => s.step === "bull");
    expect(step).toMatchObject({ status: "completed", provider: "gemini" });
    expect(step?.responseAttempts).toHaveLength(3);
  }, 30_000);

});

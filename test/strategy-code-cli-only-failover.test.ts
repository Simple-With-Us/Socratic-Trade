import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// ST-4589: a Code CLI-only model (muse-wonder-1.0-contributor) named in a Green failover chain while
// the user's Meta route is NOT Code CLI must be SKIPPED like a model with no credential, so the chain
// moves on to the next model instead of aborting the proposal phase.

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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-code-cli-only-failover-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function requestedModel(init?: RequestInit): string {
  try {
    const parsed = JSON.parse(init?.body ? String(init.body) : "{}") as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : "";
  } catch {
    return "";
  }
}

const PROPOSALS_JSON = JSON.stringify({
  proposals: [
    { symbol: "AAPL", side: "buy", type: "market", dollarAmount: 500, timeInForce: "gfd", marketHours: "regular_hours", rationale: "Bull thesis served via fallback provider.", tradeThesisTag: "Breakout", confidenceScore: 55 }
  ]
});

function ok(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({ data: { asof: "2026-06-15", table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Code CLI-only model in a Green failover chain (ST-4589)", () => {
  it("skips the Code CLI-only fallback off the Code CLI route and serves via the next model", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai")) {
        const model = requestedModel(init);
        requested.push(model);
        if (model.includes("gpt-")) return new Response("rate limited", { status: 429 });
        if (/red_team_verdict/.test(String(init?.body))) return ok(JSON.stringify({ verdict: "approve", reason: "Size is fine." }));
        return ok(PROPOSALS_JSON);
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openrouter-key", "fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Code CLI Failover", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openrouter/openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      llmFallbackModels: ["muse-wonder-1.0-contributor", "openrouter/google/gemini-2.5-flash"],
      redTeamLlmModel: "openrouter/google/gemini-2.5-flash"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.provider).toBe("gemini");
    // The Code CLI-only id never reached OpenRouter.
    expect(requested.some((model) => /muse-wonder/.test(model))).toBe(false);
    const skipped = listAudit(5000).filter(
      (e) => e.kind === "strategy_llm_failover" && (e.payload as { reason?: string; model?: string })?.model === "muse-wonder-1.0-contributor"
    );
    expect(skipped.length).toBeGreaterThan(0);
    const payload = skipped[0].payload as { action?: string; reason?: string; detail?: string };
    expect(payload.action).toBe("skip");
    // Wrong route, not a broken Code CLI: the reason says so and carries the resolver's message.
    expect(payload.reason).toBe("model_unavailable");
    expect(payload.detail).toBe("muse-wonder-1.0-contributor runs only through the Code CLI route");
  }, 30_000);
});

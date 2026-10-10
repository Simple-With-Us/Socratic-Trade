import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_MODEL_ROTATION_SENTINEL } from "../src/lib/llm-request";

const ROTATION_STUB_POOL = [
  "mistral-medium-3-5",
  "mistral-small-2603",
  "gpt-5.6-sol",
  "claude-haiku-latest",
  "claude-fable-latest",
  "deepseek-v4-flash-0731",
  "gemini-flash-lite-latest",
  "mistral-medium-latest",
  "gemini-flash-latest",
  "claude-sonnet-latest",
  "mistral-small-latest"
];

vi.mock("../src/lib/model-rotation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/model-rotation")>();
  return {
    ...actual,
    resolveModelRotationForRun: vi.fn(async () => ({
      llmModel: "mistral-medium-3-5",
      greenRotationPool: ROTATION_STUB_POOL,
      commit: () => {}
    }))
  };
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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rotate-403-${randomUUID()}.db`)}`;
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
    {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Green served after OpenRouter access-denied failover.",
      tradeThesisTag: "Breakout",
      confidenceScore: 55
    }
  ]
});

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: {
          rows: [
            {
              symbol: "AAPL",
              lastsale: "$200",
              pctchange: "1%",
              volume: "1000000",
              marketCap: "3000000000000",
              sector: "Technology",
              industry: "Consumer Electronics"
            }
          ]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function accessDenied403(): Response {
  return new Response(
    JSON.stringify({ error: { message: "Your OpenRouter key doesn't have access to this model or region." } }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}

function geminiRedOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "approve", reason: "ok" }) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("__rotate__ Green — OpenRouter 403 access-denied failover", () => {
  it("fails over past several denied slugs to a reachable seat without exhausting at three endpoints", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let greenAttempts = 0;

    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        const bodyStr = init?.body ? String(init.body) : "";
        if (bodyStr.includes("red_team_verdict")) return geminiRedOk();
        greenAttempts += 1;
        if (greenAttempts >= 5) {
          return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: PROPOSALS_JSON } }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return accessDenied403();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openrouter-key", "fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Rotate 403",
      isActive: true
    });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: LLM_MODEL_ROTATION_SENTINEL,
      redTeamLlmModel: "mistral-small-latest",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide"
    });

    const rotation = await import("../src/lib/model-rotation");
    const fallbacks = rotation.implicitGreenRotationFallbacks(ROTATION_STUB_POOL, "mistral-medium-3-5", [], Date.now(), "local");
    expect(fallbacks.length).toBeGreaterThan(2);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const failoverRows = listAudit(8000).filter(
      (e) => (e.payload as { runId?: string })?.runId === result.runId && e.kind === "strategy_llm_failover"
    );
    expect(failoverRows.length).toBeGreaterThanOrEqual(2);
    const bullLatency = listAudit(8000).filter(
      (e) =>
        (e.payload as { runId?: string; step?: string })?.runId === result.runId &&
        e.kind === "llm_call_latency" &&
        (e.payload as { step?: string }).step === "bull"
    );
    expect(bullLatency.length).toBeGreaterThanOrEqual(4);
    expect(result.proposals.length).toBeGreaterThan(0);
  }, 45_000);
});

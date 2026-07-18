import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Item 4 (Chat A): ordered cross-provider failover for the Green Team (Bull) call. Default OFF. When
// policy.llmFallbackModels is set, a transient primary failure (429/5xx/timeout) transparently serves
// via the next model, recorded loudly (strategy_llm_failover audit + served model/provider on the step).

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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-failover-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const PROPOSALS_JSON = JSON.stringify({
  proposals: [
    { symbol: "AAPL", side: "buy", type: "market", dollarAmount: 500, timeInForce: "gfd", marketHours: "regular_hours", rationale: "Bull thesis served via fallback provider.", tradeThesisTag: "Breakout", confidenceScore: 55 }
  ]
});

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({ data: { asof: "2026-06-15", table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// Gemini uses an OpenAI-compatible (chat-completions / choices) response shape.
function geminiOk(): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: PROPOSALS_JSON } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function setup(withFallback: boolean): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "fixture");
  upsertUserApiKey("local", "gemini", "test-gemini-key", "fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Failover Test", isActive: true });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "openrouter/openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    // With fallback: the Bull fails over to gemini, and the Bear also uses gemini so it isn't hit by
    // the primary's 429. Without fallback: single primary endpoint (default behavior).
    ...(withFallback
      ? {
          llmFallbackModels: ["openrouter/google/gemini-2.5-flash"],
          redTeamLlmModel: "openrouter/google/gemini-2.5-flash"
        }
      : {})
  });
}

describe("cross-provider Bull failover (Chat A item 4)", () => {
  it("flag ON: a 429 from the primary transparently serves via the fallback model and is recorded", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        const bodyStr = init?.body ? String(init.body) : "";
        if (bodyStr.includes("gpt-")) return new Response("rate limited", { status: 429 });
        return geminiOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(true);
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    // The failover is loudly recorded in the run's decision/audit trail.
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).toContain("strategy_llm_failover");
    // The Green Team step reflects the model/provider that actually SERVED the run.
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.provider).toBe("gemini");
    expect(bullStep?.reason ?? "").toMatch(/fallback|served|failed/i);
    // t3: each proposal is stamped with the FAILOVER-AWARE policy model — the fallback that
    // actually generated it, in the exact OpenRouter namespace the approval card compares
    // against `llmFallbackModels`.
    expect(result.proposals.length).toBeGreaterThan(0);
    for (const p of result.proposals) {
      expect(p.proposal.proposedByModel).toBe("openrouter/google/gemini-2.5-flash");
    }
  }, 30_000);

  it("flag OFF (default): a primary 429 is a hard failure — no failover, behavior unchanged", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) return new Response("rate limited", { status: 429 });
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });
    await setup(false);
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();

    expect(result.status).toBe("failed");
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).not.toContain("strategy_llm_failover");
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

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

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-e2e-money-path-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb().exec("DELETE FROM trade_proposals;");
});

const BULL_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 1000,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Bull thesis for AAPL E2E",
  tradeThesisTag: "Momentum-Breakout",
  confidenceScore: 85
};

function nasdaqResponse(): Response {
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

function bullOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ proposals: [BULL_PROPOSAL] }) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function bearOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ proposals: [BULL_PROPOSAL] }) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function redTeamOk(): Response {
  // Single-adversary consolidation: the reviewer returns the three-way {verdict, reason} shape.
  // "approve" = proceed at the finalized size, so the money path completes to a placed order.
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "E2E looks good to me" }) } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function stubFetchE2E(): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
      const body = String(init?.body ?? "");
      const isRedTeam = body.includes("Red Team Risk Agent") || body.includes("rigorously critique");
      const isBear = body.includes("Bear Agent") || body.includes("bear_proposals");
      if (isRedTeam) {
         return redTeamOk();
      }
      if (isBear) {
         return bearOk();
      }
      return bullOk();
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupBrokerLiveAutonomous(label: string): Promise<void> {
  // vi.stubEnv (not a raw process.env assignment) so afterEach's vi.unstubAllEnvs() restores it and
  // the live-trading opt-in can't leak into subsequent tests/files.
  vi.stubEnv("ALLOW_LIVE_TRADING", "true");
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  // Broker "alpaca" with environment "live" so this resolves broker/live
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "alpaca",
    environment: "live",
    accountNumber: "TEST",
    label,
    apiKey: "PK-TEST",
    apiSecret: "sk-test",
    isActive: true
  });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    activeBroker: "alpaca",
    accountNumber: "TEST",
    llmModel: "openai/gpt-4.1-mini",
    // No-defaults world: the single Red Team reviewer must be an explicit pick or the risk-adding
    // opening fails closed to human review. Same OpenAI-family model as the proposer so the fetch
    // stub serves its "Red Team Risk Agent" call through the openrouter.ai endpoint.
    redTeamLlmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    maxOrderPctOfNav: 100,
    maxDailyNotional: 400_000,
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  });
}

describe("E2E money-path integration test", () => {
  it("runs strategy through to execution", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    // Keys for both LLM families present so Red Team credential resolution never fails-closed; the
    // fetch stub actually serves the Red Team through the OpenAI-family endpoint.
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    // Deterministic trading day: runStrategyOnce() skips non-manual runs when isTradingDay() is
    // false, so force the VITEST-only seam on to keep this test off the calendar (weekends/holidays).
    vi.stubEnv("AGENTIC_TEST_FORCE_TRADING_DAY", "1");
    stubFetchE2E();
    await setupBrokerLiveAutonomous("E2E Live");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce("local", { manual: false });

    expect(result.status).toBe("completed");

    const aaplProposal = result.proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal).toBeDefined();
    expect(aaplProposal?.id).toEqual(expect.any(String));
    expect(getProposal(aaplProposal!.id!, "local")?.id).toBe(aaplProposal!.id);

    // The Test broker completes synchronously, so result.proposals keeps the terminal `filled`
    // truth instead of collapsing it back to the less-specific `placed` state.
    expect(aaplProposal?.status).toBe("filled");
    
    // Check audit logs for the money path success
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
      
    expect(runKinds).toContain("candidates_considered");
  }, 30_000);
});

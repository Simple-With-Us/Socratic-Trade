import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
process.env.OPENROUTER_API_KEY = "test-key";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Item 7 (Chat A): the rationale-diversity collapse detector was advisory-only (console.warn). Behind
// a default-off flag (policy.tuning.gateOnRationaleCollapse), a collapsed run's OPENING proposals must
// route to human review instead of auto-executing. Flag off => byte-identical advisory behavior.

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-collapse-gate-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// A long identical rationale so both proposals collapse (near-1.0 similarity) even after per-symbol
// sizing notes are appended during the run.
const IDENTICAL_RATIONALE =
  "The setup is a high-quality momentum breakout with expanding volume and improving breadth. " +
  "Relative strength is firmly positive, the trend structure is intact above rising moving averages, " +
  "and the macro regime is supportive with a benign volatility backdrop and constructive credit. " +
  "Fundamentals corroborate the technical picture: healthy free cash flow, low leverage, and a durable " +
  "competitive position. Risk is defined with a clear invalidation level and a favorable reward-to-risk. " +
  "This is a textbook continuation entry consistent with the strategy playbook and current conditions.";

function bullBearProposals() {
  return {
    output_text: JSON.stringify({
      proposals: [
        { symbol: "AAPL", side: "buy", type: "market", dollarAmount: 1000, timeInForce: "gfd", marketHours: "regular_hours", rationale: IDENTICAL_RATIONALE, tradeThesisTag: "Breakout", confidenceScore: 60 },
        { symbol: "XOM", side: "buy", type: "market", dollarAmount: 1000, timeInForce: "gfd", marketHours: "regular_hours", rationale: IDENTICAL_RATIONALE, tradeThesisTag: "Breakout", confidenceScore: 60 }
      ]
    })
  };
}

function nasdaqRows(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: {
          rows: [
            { symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" },
            { symbol: "XOM", lastsale: "$110", pctchange: "1%", volume: "1000000", marketCap: "400000000000", sector: "Energy", industry: "Oil & Gas" }
          ]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function runCollapse(gateOn: boolean) {
  vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const href = String(url);
    // Both the Bull and the surviving-Bear response return the two identical-rationale buys.
    if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
      return new Response(JSON.stringify(bullBearProposals()), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("nasdaq.com")) return nasdaqRows();
    return new Response("not found", { status: 404 });
  });

  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({ id: accountId, userId: "local", broker: "alpaca", environment: "paper", accountNumber: "TEST", label: `collapse ${gateOn}`, apiKey: "PK", apiSecret: "sk", isActive: true });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    activeBroker: "alpaca",
    accountNumber: "TEST",
    llmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL", "XOM"],
    strategyAuthority: "decide",
    maxOrderPctOfNav: 100,
    maxDailyNotional: 400_000,
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000,
    tuning: { ...(DEFAULT_POLICY.tuning ?? {}), gateOnRationaleCollapse: gateOn }
  });

  const { runStrategyOnce } = await import("../src/lib/strategy");
  const result = await runStrategyOnce();
  const runKinds = listAudit(500)
    .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
    .map((e) => e.kind);
  return { result, runKinds };
}

describe("rationale-collapse gate (Chat A item 7)", () => {
  it("flag ON: a collapsed run routes opening proposals to human review (not auto-executed)", async () => {
    const { result, runKinds } = await runCollapse(true);
    expect(runKinds).toContain("strategy_rationale_collapse_gated");
    // The gated openings are routed to a human ("proposed"), not auto-executed.
    expect(result.proposals.map((p) => p.status)).toContain("proposed");
  }, 30_000);

  it("flag OFF (default): the collapse stays advisory — no gate audit, proposals not gate-routed", async () => {
    const { runKinds } = await runCollapse(false);
    expect(runKinds).not.toContain("strategy_rationale_collapse_gated");
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Item 1 (Chat A): the inline Bear (Red Team) review MUST fail closed. When the Bear call errors,
// returns non-200, times out, or returns unparseable JSON, an autonomous ("decide") run must route
// the un-critiqued Bull proposals to human review — never auto-execute them.

vi.mock("../src/lib/vector-db", () => ({
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
// Use the canned local test gateway (no HTTP) even for an "alpaca" paper account, so the run reaches
// broker/paper mode without needing real Alpaca credentials or network.
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});
// (No tax mock: on a fresh temp DB the real wash-sale lookup returns an empty locked set, and the
// portfolio path needs the module's other exports intact.)

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-bear-failclosed-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Each parametrized case shares this file's DB. Clear prior proposals so a "proposed" AAPL from a
// previous case can't (a) trigger a pending-proposal revalidation LLM call or (b) get AAPL de-duped
// out of the next case's scan — both of which would make the run produce zero proposals.
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
  rationale: "Bull thesis for AAPL",
  tradeThesisTag: "Breakout",
  // Below the Red Team conviction threshold (80) so the *standalone* debate never runs — this test
  // isolates the INLINE Bear path (exactly two OpenAI calls: Bull then Bear).
  confidenceScore: 60
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
  return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [BULL_PROPOSAL] }) }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

// Route by request BODY (not call order, which extra calls like revalidation could shift): the Bear
// request carries the "Bear Agent" system prompt / "bear_proposals" schema and fails per `bearFailure`;
// every other Green-Team/revalidation call gets a valid single-buy proposal set.
function stubFetchBearFailure(bearFailure: "http429" | "throw" | "malformed"): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      const body = String(init?.body ?? "");
      const isBear = body.includes("Bear Agent") || body.includes("bear_proposals");
      if (isBear) {
        if (bearFailure === "http429") return new Response("rate limited", { status: 429 });
        if (bearFailure === "malformed") {
          return new Response(JSON.stringify({ output_text: "```\nnot valid json {{{" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error("The operation was aborted due to timeout");
      }
      return bullOk();
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupBrokerPaperDecide(label: string): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  // Broker "alpaca" with environment "paper" so this resolves broker/paper (not broker/live); the
  // gateway is mocked to the canned local sim above, so no real Alpaca credentials/network are used.
  // accountNumber "TEST" matches what the test gateway's getAccounts() reports.
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "alpaca",
    environment: "paper",
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
    // An active alpaca paper account => broker/paper, so the requiresHumanReview branch actually
    // routes to "proposed" instead of auto-placing through the broker.
    activeBroker: "alpaca",
    accountNumber: "TEST",
    llmModel: "gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    // Relax caps so a single $1000 AAPL buy survives the risk gates and reaches the routing branch.
    maxOrderPctOfNav: 100,
    // Kept just under the db.ts safety clamp (>=500_000 is reset to the 500 default).
    maxDailyNotional: 400_000,
    // 0/falsy disables the NAV-relative daily cap (the test broker reports ~0 NAV, which would
    // otherwise make the percent-of-NAV ceiling 0 and block every opening).
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  });
}

describe("inline Bear red-team fail-closed (Chat A item 1)", () => {
  it.each(["http429", "throw", "malformed"] as const)(
    "routes Bull proposals to human review (never auto-executes) when the Bear call fails (%s) in decide mode",
    async (bearFailure) => {
      vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
      stubFetchBearFailure(bearFailure);
      await setupBrokerPaperDecide(`Bear ${bearFailure}`);
      const { runStrategyOnce } = await import("../src/lib/strategy");
      const { listAudit } = await import("../src/lib/db");

      const result = await runStrategyOnce();

      // The un-critiqued Bull proposal is routed to a human ("proposed"), never auto-executed.
      const statuses = result.proposals.map((p) => p.status);
      expect(statuses).toContain("proposed");
      expect(statuses).not.toContain("paper");
      expect(statuses).not.toContain("filled");
      expect(statuses).not.toContain("placing");

      // The fail-closed path emitted the loud audit signals from both proposeTrades and the caller.
      // Scope to this run's runId — the temp DB is shared across the tests in this file.
      const runKinds = listAudit(500)
        .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
        .map((e) => e.kind);
      expect(runKinds).toContain("strategy_bear_review_unavailable");
      expect(runKinds).toContain("strategy_bear_review_routed_to_human");

      // The Bear step is recorded as fallback (not "completed").
      const bearStep = result.llmSteps?.find((s) => s.step === "bear");
      expect(bearStep?.status).toBe("fallback");
    },
    30_000
  );

  it("routes Bull proposals to human review when the Bear LLM key is not configured (decide mode)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    // Force the Red Team's (gemini) provider to have NO key so the inline Bear is skipped for lack of
    // a credential — the fourth acceptance failure mode ("missing-key").
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      // Only the Bull runs (the Bear is skipped, no fetch); return the buy.
      if (href.includes("api.openai.com")) return bullOk();
      if (href.includes("nasdaq.com")) return nasdaqResponse();
      return new Response("not found", { status: 404 });
    });
    await setupBrokerPaperDecide("Bear no-key");
    const { setPolicy, getPolicy, listAudit } = await import("../src/lib/db");
    // Point the Red Team at a provider with no configured key so bearKey resolves empty.
    setPolicy({ ...getPolicy(), redTeamLlmModel: "gemini-2.5-flash" });
    const { runStrategyOnce } = await import("../src/lib/strategy");

    const result = await runStrategyOnce();

    const statuses = result.proposals.map((p) => p.status);
    expect(statuses).toContain("proposed");
    expect(statuses).not.toContain("paper");
    expect(statuses).not.toContain("filled");
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).toContain("strategy_bear_review_unavailable");
    expect(runKinds).toContain("strategy_bear_review_routed_to_human");
    // No key → the Bear step is recorded as "skipped" (not "fallback").
    const bearStep = result.llmSteps?.find((s) => s.step === "bear");
    expect(bearStep?.status).toBe("skipped");
  }, 30_000);

  it("does NOT flag bearReviewUnavailable when the Bear call succeeds", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      // Both the Bull and the surviving-Bear response are valid proposal JSON.
      if (href.includes("api.openai.com")) return bullOk();
      if (href.includes("nasdaq.com")) return nasdaqResponse();
      return new Response("not found", { status: 404 });
    });
    await setupBrokerPaperDecide("Bear OK");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).not.toContain("strategy_bear_review_unavailable");
    expect(runKinds).not.toContain("strategy_bear_review_routed_to_human");
    // Regression (composite review B/high/S): the inline Bear schema now includes confidenceScore in
    // both `properties` and `required`, so a Bear-surviving proposal retains a numeric score instead
    // of silently degrading to undefined (which previously zeroed shouldRunRedTeamDebate's `?? 0`
    // trigger and sizing's `?? 50` neutral fallback).
    const aaplProposal = result.proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal?.proposal.confidenceScore).toBe(BULL_PROPOSAL.confidenceScore);
  }, 30_000);
});

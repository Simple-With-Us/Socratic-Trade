import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
process.env.OPENROUTER_API_KEY = "test-key";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Single-adversary consolidation (2026-07-07): the ONE Red Team review MUST fail closed. When the
// review call errors, returns non-200, times out, or returns unparseable JSON, an autonomous
// ("decide") run must route the un-reviewed risk-adding opening to human review — never
// auto-execute it. (This file previously covered the in-flow Bear's fail-closed path; the Bear was
// deleted and the same guarantees now live on the consolidated post-sizing review.)

vi.mock("../src/lib/vector-db", () => ({
  getCurrentVectorProviderAuthority: vi.fn(),
  managedVectorLedgerAuthority: vi.fn(),
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
  // Confidence no longer gates the review (universal coverage): every risk-adding opening is
  // reviewed, so exactly two OpenAI calls run — Bull, then the single Red Team review.
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

function reviewApprove(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "Evidence checks out." }) } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// Route by request BODY (not call order): the Red Team review carries the "Red Team Risk Agent"
// system prompt and fails per `reviewFailure`; every other Green-Team/revalidation call gets a
// valid single-buy proposal set.
function stubFetchReviewFailure(reviewFailure: "http429" | "throw" | "malformed"): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      const body = String(init?.body ?? "");
      const isReview = body.includes("Red Team Risk Agent") || body.includes("red_team_verdict");
      if (isReview) {
        if (reviewFailure === "http429") return new Response("rate limited", { status: 429 });
        if (reviewFailure === "malformed") {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "```\nnot valid json {{{" } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
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
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
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
    activeBroker: "alpaca",
    accountNumber: "TEST",
    llmModel: "openai/gpt-4.1-mini",
    // Both models are required explicit picks now (no defaults, no fallback to Green).
    redTeamLlmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    // Relax caps so a single $1000 AAPL buy survives the risk gates and reaches the routing branch.
    maxOrderPctOfNav: 100,
    // Large explicit dollar mode keeps this test focused on Red-Team fail-closed routing.
    maxDailyNotional: 400_000,
    // 0/falsy disables the NAV-relative daily cap (the test broker reports ~0 NAV, which would
    // otherwise make the percent-of-NAV ceiling 0 and block every opening).
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  });
}

describe("single Red Team review fail-closed (§3.7)", () => {
  it.each([
    ["http429", "rate_limited"],
    ["throw", "timeout"],
    ["malformed", "malformed_response"]
  ] as const)(
    "routes the opening to human review (never auto-executes) when the review fails (%s → %s) in decide mode",
    async (reviewFailure, expectedKind) => {
      vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
      stubFetchReviewFailure(reviewFailure);
      await setupBrokerPaperDecide(`Review ${reviewFailure}`);
      const { runStrategyOnce } = await import("../src/lib/strategy");
      const { listAudit, listRecentProposals } = await import("../src/lib/db");

      const result = await runStrategyOnce();

      // The un-reviewed opening is routed to a human ("proposed"), never auto-executed.
      const statuses = result.proposals.map((p) => p.status);
      expect(statuses).toContain("proposed");
      expect(statuses).not.toContain("paper");
      expect(statuses).not.toContain("filled");
      expect(statuses).not.toContain("placing");

      // The fail-closed path emitted the loud per-proposal audit signal, with the right failureKind.
      const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
      const unavailable = runAudits.filter((e) => e.kind === "strategy_red_team_unavailable");
      expect(unavailable.length).toBeGreaterThanOrEqual(1);
      expect((unavailable[0].payload as { failureKind?: string }).failureKind).toBe(expectedKind);
      expect((unavailable[0].payload as { heldForHuman?: boolean }).heldForHuman).toBe(true);

      // R19: the stored decision carries the machine-readable badge flag + reason.
      const aapl = listRecentProposals("TEST", 100, "local").find((p) => p.proposal.symbol === "AAPL");
      expect(aapl?.proposal.redTeamVerdict?.available).toBe(false);
      expect(aapl?.proposal.redTeamVerdict?.failureKind).toBe(expectedKind);
      expect((aapl?.decision as { adversaryUnavailable?: boolean } | undefined)?.adversaryUnavailable).toBe(true);
    },
    30_000
  );

  it("routes the opening to human review when the Red model's provider has no key (not_configured)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    // Point the Red Team at a provider with no configured key so the review resolves keyless.
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      // Only the Bull runs (the review is skipped keyless, no fetch); return the buy.
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) return bullOk();
      if (href.includes("nasdaq.com")) return nasdaqResponse();
      return new Response("not found", { status: 404 });
    });
    await setupBrokerPaperDecide("Review no-key");

    const { setPolicy, getPolicy, listAudit, deleteUserApiKey, upsertUserApiKey } = await import("../src/lib/db");
    deleteUserApiKey("local", "gemini");
    deleteUserApiKey("local", "openrouter");
    upsertUserApiKey("local", "openai", "test-openai-key", "test");

    setPolicy({ ...getPolicy(), redTeamLlmModel: "gemini-2.5-flash" });
    const { runStrategyOnce } = await import("../src/lib/strategy");

    const result = await runStrategyOnce();

    const statuses = result.proposals.map((p) => p.status);
    expect(statuses).toContain("proposed");
    expect(statuses).not.toContain("paper");
    expect(statuses).not.toContain("filled");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const unavailable = runAudits.filter((e) => e.kind === "strategy_red_team_unavailable");
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect((unavailable[0].payload as { failureKind?: string }).failureKind).toBe("not_configured");
  }, 30_000);

  it("routes the opening to human review when NO Red model is chosen at all (blank — no Green fallback)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) return bullOk();
      if (href.includes("nasdaq.com")) return nasdaqResponse();
      return new Response("not found", { status: 404 });
    });
    await setupBrokerPaperDecide("Review blank model");
    const { setPolicy, getPolicy, listAudit } = await import("../src/lib/db");
    const policy = { ...getPolicy() };
    delete (policy as { redTeamLlmModel?: string }).redTeamLlmModel;
    setPolicy(policy);
    const { runStrategyOnce } = await import("../src/lib/strategy");

    const result = await runStrategyOnce();

    const statuses = result.proposals.map((p) => p.status);
    expect(statuses).toContain("proposed");
    expect(statuses).not.toContain("paper");
    expect(statuses).not.toContain("filled");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const unavailable = runAudits.filter((e) => e.kind === "strategy_red_team_unavailable");
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect((unavailable[0].payload as { failureKind?: string }).failureKind).toBe("not_configured");
    expect((unavailable[0].payload as { reason?: string }).reason).toMatch(/not chosen/i);
  }, 30_000);

  it("does NOT flag unavailable when the review succeeds — the verdict is stamped and no hold audit fires", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
        const body = String(init?.body ?? "");
        if (body.includes("Red Team Risk Agent") || body.includes("red_team_verdict")) return reviewApprove();
        return bullOk();
      }
      if (href.includes("nasdaq.com")) return nasdaqResponse();
      return new Response("not found", { status: 404 });
    });
    await setupBrokerPaperDecide("Review OK");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).not.toContain("strategy_red_team_unavailable");

    // The verdict is stamped first-class with universal-coverage trigger, and the proposal's
    // confidence survives (no second schema pass to strip it anymore).
    const aaplProposal = result.proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal?.proposal.redTeamVerdict?.available).toBe(true);
    expect(aaplProposal?.proposal.redTeamVerdict?.verdict).toBe("approve");
    expect(aaplProposal?.proposal.redTeamVerdict?.trigger).toBe("all_openings");
    expect(aaplProposal?.proposal.confidenceScore).toBe(BULL_PROPOSAL.confidenceScore);
  }, 30_000);
});

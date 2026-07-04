import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Wave-3 schema & dissent, run-level integration (composite review B/high "Bear removed[]" +
// A/high "Non-actions as case files"):
//   1. An inline-Bear removed[] entry persists as a Socratic case with status 'vetoed' AND (for an
//      opening) inserts a skipped-candidate counterfactual row — the veto learning loop.
//   2. Survivors carry the per-survivor structured bearVerdict on redTeamVerdict, with the
//      round-tripped Socratic fields intact (the confidenceScore regression pattern, live).
//   3. A run that proposes nothing writes a run-level 'waited' case (id = runId) and per-symbol
//      'passed' cases from the Bull's passedOn[].

vi.mock("../src/lib/vector-db", () => ({
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => ({ attempted: 1, indexed: 1 })
}));
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-w3-removed-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb().exec("DELETE FROM trade_proposals; DELETE FROM socratic_decisions; DELETE FROM skipped_candidate_counterfactuals;");
});

const SOCRATIC_FIELDS = {
  belief: "AI capex supercycle persists.",
  iMayBeWrongIf: ["Hyperscaler capex guides down"],
  reversalTriggers: [{ condition: "VIX spikes above 25", metric: "VIX", level: 25 }],
  evidenceRefs: ["fcf", "techScore"],
  usedEvidence: [{ ref: "fcf", effect: "used", why: "strong yield" }],
  strongestCounterRead: "Momentum is extended; a pullback is the base case."
};

const bullProposal = (symbol: string, confidence: number) => ({
  symbol,
  side: "buy",
  type: "market",
  dollarAmount: 1000,
  quantity: null,
  limitPrice: null,
  stopPrice: null,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: `Bull thesis for ${symbol}`,
  tradeThesisTag: "Momentum-Breakout",
  // Below the standalone-debate conviction threshold (80) so only the INLINE Bear runs.
  confidenceScore: confidence,
  autonomyOverride: null,
  ...SOCRATIC_FIELDS
});

function nasdaqResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: {
          rows: [
            { symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" },
            { symbol: "MSFT", lastsale: "$400", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Software" }
          ]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** Route by request body: the Bear call gets the two-list review; every other OpenAI call gets the Bull set. */
function stubFetch(opts: { bull: unknown; bear: unknown }): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      const body = String(init?.body ?? "");
      const isBear = body.includes("Bear Agent") || body.includes("bear_proposals");
      return new Response(JSON.stringify({ output_text: JSON.stringify(isBear ? opts.bear : opts.bull) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupBrokerPaperDecide(label: string): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
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
    llmModel: "gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL", "MSFT"],
    strategyAuthority: "decide",
    maxOrderPctOfNav: 100,
    maxDailyNotional: 400_000,
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  });
}

describe("inline Bear removed[] -> vetoed cases + veto counterfactuals (w3-schema-dissent)", () => {
  it("persists the removed proposal as a 'vetoed' case, records its counterfactual, and keeps the survivor's structured verdict + round-tripped fields", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    stubFetch({
      bull: { proposals: [bullProposal("AAPL", 60), bullProposal("MSFT", 55)], passedOn: [] },
      bear: {
        proposals: [
          {
            ...bullProposal("AAPL", 60),
            bearVerdict: {
              verdict: "approve_with_changes",
              keyRisks: ["Concentration in megacap tech"],
              invalidationTriggers: [{ condition: "Breaks below 190", metric: "price", level: 190 }],
              suggestedChange: { sizeMultiplier: 0.5, stopPrice: null, limitPrice: null },
              wouldApproveIf: "Half size",
              confidence: 70,
              reason: "Acceptable at reduced size."
            }
          }
        ],
        removed: [{ symbol: "MSFT", side: "buy", reason: "Valuation stretched into a weak seasonal window.", severity: "high" }]
      }
    });
    await setupBrokerPaperDecide("removed-vetoed");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listSocraticDecisionCases, listRecentProposals, getDb } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // 1. The removed MSFT buy is a durable 'vetoed' case with the severity-graded reason.
    const cases = listSocraticDecisionCases("local", { limit: 100 });
    const vetoed = cases.find((c) => c.status === "vetoed" && c.symbol === "MSFT");
    expect(vetoed).toBeDefined();
    expect(vetoed?.policyDecision?.reasons[0]).toContain("Red Team (inline Bear) veto [severity=high]");
    expect(vetoed?.policyDecision?.reasons[0]).toContain("Valuation stretched");
    // The vetoed case carries the Bull's full Socratic fields (belief etc.) for memory retrieval.
    expect(vetoed?.belief).toBe(SOCRATIC_FIELDS.belief);

    // 2. The vetoed OPENING entered the counterfactual pipeline (missed-opportunity learning).
    const cfRows = getDb()
      .prepare("SELECT symbol FROM skipped_candidate_counterfactuals WHERE symbol = 'MSFT'")
      .all() as Array<{ symbol: string }>;
    expect(cfRows.length).toBeGreaterThanOrEqual(1);

    // 3. The AAPL survivor persisted with the structured inline-Bear verdict and the round-tripped
    //    Socratic fields (confidenceScore regression pattern, live end-to-end).
    const proposals = listRecentProposals("TEST", 100, "local");
    const aapl = proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl?.proposal.confidenceScore).toBe(60);
    expect(aapl?.proposal.belief).toBe(SOCRATIC_FIELDS.belief);
    expect(aapl?.proposal.strongestCounterRead).toBe(SOCRATIC_FIELDS.strongestCounterRead);
    expect(aapl?.proposal.reversalTriggers).toEqual(SOCRATIC_FIELDS.reversalTriggers);
    expect(aapl?.proposal.redTeamVerdict).toMatchObject({
      rejected: false,
      available: true,
      verdict: "approve_with_changes",
      keyRisks: ["Concentration in megacap tech"],
      suggestedChange: { sizeMultiplier: 0.5 },
      confidence: 70,
      reason: "Acceptable at reduced size."
    });
    // The ADVISORY suggested change is a receipt, never applied: the advised size is untouched.
    expect(aapl?.proposal.reviewNotes?.some((note: string) => note.includes("ADVISORY"))).toBe(true);
  }, 30_000);
});

describe("non-actions: passedOn[] cases + run-level 'waited' case (w3-schema-dissent)", () => {
  it("a run that proposes nothing writes per-symbol 'passed' cases and a 'waited' case keyed by runId", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    stubFetch({
      bull: {
        proposals: [],
        passedOn: [
          { symbol: "AAPL", reason: "Extended after earnings; no fresh edge.", wouldReconsiderIf: "Pullback to the 20-day." },
          { symbol: "MSFT", reason: "Better risk/reward elsewhere.", wouldReconsiderIf: null }
        ]
      },
      // With zero Bull proposals the Bear reviews nothing and returns empty lists.
      bear: { proposals: [], removed: [] }
    });
    await setupBrokerPaperDecide("passed-waited");
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listSocraticDecisionCases, getSocraticDecisionCase } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const cases = listSocraticDecisionCases("local", { limit: 100 });
    const passedAapl = cases.find((c) => c.status === "passed" && c.symbol === "AAPL");
    expect(passedAapl).toBeDefined();
    expect(passedAapl?.rationale).toContain("Extended after earnings");
    expect(passedAapl?.wouldReconsiderIf).toContain("20-day");
    const passedMsft = cases.find((c) => c.status === "passed" && c.symbol === "MSFT");
    expect(passedMsft).toBeDefined();
    expect(passedMsft?.wouldReconsiderIf).toBeUndefined();

    // Run-level 'waited' case, keyed by the runId, carrying the model-declined reason + the passes.
    const waited = getSocraticDecisionCase(result.runId, "local");
    expect(waited?.status).toBe("waited");
    expect(waited?.action).toBe("WAITED");
    expect(waited?.rationale).toContain("model-declined");
    expect(waited?.rationale).toContain("AAPL");
  }, 30_000);
});

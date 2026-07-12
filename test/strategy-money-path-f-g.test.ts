import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// End-to-end "money-path" + red-team wiring tests (audit work-split Chat F/G).
//
// Drives runStrategyOnce against a connected TEST-BROKER account (broker: "test", environment:
// "paper" — test infrastructure, TestBrokerGateway) with a stubbed LLM so the full proposal →
// evaluate → execute path is exercised through the normal broker placement flow. Asserts:
//   - G7: a paper fill is booked and a proposal + fill_event are persisted.
//   - F1: the persisted proposal carries the new `redTeamVerdict` field.
//   - F2: a Bear rejection writes an audit("proposal_rejected_by_red_team") row.
//
// The vector-db is mocked so the run needs no embeddings provider.
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

beforeEach(() => {
  // Reset the module cache so the DB singleton (a module-level `let db` in db.ts) re-opens against
  // this test's fresh temp file rather than reusing the previous test's connection/data.
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-money-path-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENAI_API_KEY;
});

/** A high-conviction (>=80) buy the Bull proposes and the Bear keeps — triggers the Red Team debate. */
const BULL_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Strong momentum with fundamental support.",
  tradeThesisTag: "Quality-Compounder",
  entryMarketRegime: "Neutral (Normal Volatility)",
  confidenceScore: 90
};

/** Build the fetch stub. `redTeamVerdict` decides the Bear (Red Team) debate response. */
function makeFetchStub(opts: {
  redTeamVerdict: { rejected: boolean; reason: string };
  bullProposals?: unknown[];
  onOpenAiBody?: (body: any) => void;
}) {
  const proposals = opts.bullProposals ?? [BULL_PROPOSAL];
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      opts.onOpenAiBody?.(body);
      // The Red Team debate (debateProposal) system prompt contains "Red Team Risk Agent";
      // the Bull/Bear strategy calls don't. Route by that marker.
      const systemContent = JSON.stringify(body);
      if (systemContent.includes("Red Team Risk Agent")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(opts.redTeamVerdict) } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // Bull and Bear both return the same proposal set (bear "keeps" the bull proposal).
      return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals }) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) {
      return new Response(
        JSON.stringify({
          data: {
            asof: "2026-06-30",
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
    return new Response("not found", { status: 404 });
  };
}

async function seedTestAccountAndPolicy() {
  const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "test",
    environment: "paper",
    accountNumber: "TEST",
    label: "Test Account",
    isActive: true
  });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide"
  });
}

describe("strategy money-path (broker/paper via the Test-broker gateway) — G7 + F1", () => {
  it("books a broker-paper fill and persists a proposal + fill_event with the redTeamVerdict field (survived)", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", makeFetchStub({ redTeamVerdict: { rejected: false, reason: "No fatal flaw found." } }));

    await seedTestAccountAndPolicy();
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listFillEvents, listRecentProposals } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // G7: the full path placed a real order through TestBrokerGateway and booked the fill.
    const fills = listFillEvents("TEST", undefined, 100, "local");
    const aaplFill = fills.find((f) => f.symbol === "AAPL");
    expect(aaplFill).toBeDefined();
    expect(aaplFill?.status).toBe("filled");
    expect(aaplFill?.source).toBe("paper");

    // A proposal was persisted for AAPL, placed through the normal broker path.
    const proposals = listRecentProposals("TEST", 100, "local");
    const aaplProposal = proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal).toBeDefined();
    expect(aaplProposal?.status).toBe("placed");

    // F1: the redTeamVerdict field round-trips through the persisted JSON payload (no migration),
    // including the served red-team model attribution (t3) and the stakes-scaled-dissent trigger
    // (E/high/S) — this proposal's confidenceScore (90) alone clears the threshold.
    expect(aaplProposal?.proposal.redTeamVerdict).toEqual({
      rejected: false,
      available: true,
      reason: "No fatal flaw found.",
      model: "gpt-4.1-mini",
      trigger: "confidence"
    });
    // t3: the persisted proposal carries the FAILOVER-AWARE served Green model (here the primary),
    // so approval-time attribution doesn't drift with later policy edits.
    expect(aaplProposal?.proposal.proposedByModel).toBe("gpt-4.1-mini");
    // Backward-compat rationale text is still appended.
    expect(aaplProposal?.proposal.rationale).toContain("Red Team Debate Survived");
    // Regression (composite review B/high/S): the Bear schema now round-trips confidenceScore — a
    // Bear-surviving proposal must retain the Bull's numeric conviction score, not degrade to
    // undefined (which previously zeroed shouldRunRedTeamDebate/sizing downstream).
    expect(aaplProposal?.proposal.confidenceScore).toBe(90);
  }, 30_000);
});

describe("strategy LLM budget ceiling — choke point AFTER risk breakers", () => {
  it("skips LLM generation (no OpenAI call, no fill) but still COMPLETES when over the daily budget", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubEnv("TRIGGER_LLM_DAILY_TOKEN_BUDGET", "1000");
    let openAiCalled = false;
    vi.stubGlobal(
      "fetch",
      makeFetchStub({ redTeamVerdict: { rejected: false, reason: "n/a" }, onOpenAiBody: () => { openAiCalled = true; } })
    );

    await seedTestAccountAndPolicy();
    const { getDb, listFillEvents, listAudit } = await import("../src/lib/db");
    // Seed today's usage OVER the 1000-token ceiling for this user.
    getDb()
      .prepare(
        `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, 'local', 'openai', 'gpt-4o', 'strategy', 'user', NULL, 0, 1200, 1200, NULL, ?)`
      )
      .run(randomUUID(), new Date().toISOString());

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    // The run still COMPLETES — non-LLM safety maintenance (reconcile + drawdown breaker) ran; only
    // the LLM proposal generation was skipped by the budget gate.
    expect(result.status).toBe("completed");
    expect(listAudit(500).filter((e) => e.kind === "strategy_run_suppressed_budget").length).toBeGreaterThanOrEqual(1);
    // The Bull/Bear model call never fired.
    expect(openAiCalled).toBe(false);
    // No proposal → no AAPL fill.
    expect(listFillEvents("TEST", undefined, 100, "local").find((f) => f.symbol === "AAPL")).toBeUndefined();
  }, 30_000);
});

describe("strategy Red Team rejection — F2 audit", () => {
  it("writes an audit('proposal_rejected_by_red_team') row and drops the proposal on a Bear veto", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal(
      "fetch",
      makeFetchStub({ redTeamVerdict: { rejected: true, reason: "Overbought into earnings; asymmetric downside." } })
    );

    await seedTestAccountAndPolicy();
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listFillEvents } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // F2: the Bear veto is audited (parity with proposal_skipped_negative_ev / _correlation).
    const rejectionAudits = listAudit(500).filter((e) => e.kind === "proposal_rejected_by_red_team");
    expect(rejectionAudits.length).toBeGreaterThanOrEqual(1);
    const payload = rejectionAudits[0].payload as {
      runId?: string;
      symbol?: string;
      side?: string;
      thesisTag?: string;
      reason?: string;
      model?: string;
    };
    expect(payload.symbol).toBe("AAPL");
    expect(payload.side).toBe("buy");
    expect(payload.thesisTag).toBe("Quality-Compounder");
    expect(payload.reason).toContain("Overbought");
    // runId + model are stamped so getRedTeamEfficacy() can join this veto to its matured
    // counterfactual return.
    expect(payload.runId).toBe(result.runId);
    expect(payload.model).toBe("gpt-4.1-mini");

    // A rejected proposal never reaches execution → no AAPL fill was booked.
    const fills = listFillEvents("TEST", undefined, 100, "local");
    expect(fills.find((f) => f.symbol === "AAPL")).toBeUndefined();

    // A Bear veto now feeds the SAME counterfactual pipeline as a policy block / human rejection
    // (recordRejectedProposalCounterfactual), so its post-veto return can mature into
    // getRedTeamEfficacy() below — previously the Red Team's own vetoes were the one rejection path
    // with zero downstream measurement.
    const { getRedTeamEfficacy } = await import("../src/lib/performance");
    const efficacy = getRedTeamEfficacy("local");
    expect(efficacy.totalVetoes).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Usage-budget Phase 2 wiring into runStrategyOnce (advisory-first, owner-controlled enforcement).
// Modeled on test/strategy-money-path-f-g.test.ts: drives runStrategyOnce against a connected
// TEST-BROKER account (broker: "test", environment: "paper" — test infrastructure) with a stubbed
// LLM so the full budget-status -> advisory-injection -> (optional) enforcement path is exercised.
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

const BASE = "https://usage.example.test";
const TOKEN = "test-usage-token";

beforeEach(() => {
  // Reset the module cache so the DB singleton (a module-level `let db` in db.ts) re-opens against
  // this test's fresh temp file rather than reusing the previous test's connection/data.
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-usage-budget-strategy-${randomUUID()}.db`)}`;
  process.env.USAGE_MONITOR_BASE_URL = BASE;
  process.env.USAGE_INGEST_TOKEN = TOKEN;
  // usage-budget's TTL cache is intentionally globalThis-pinned (so HMR can't split it in dev) —
  // that also means it survives vi.resetModules() across tests in this same process. Clear it here
  // so each test's stubbed fetch response is the one actually consulted, not a prior test's cached
  // status. This reaches into the same key the module uses; no production code change needed.
  delete (globalThis as { __usageBudgetCache?: unknown }).__usageBudgetCache;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENAI_API_KEY;
  delete process.env.USAGE_MONITOR_BASE_URL;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_BUDGET_ENFORCE;
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

function budgetStatusPayload(providers: Array<{ name: string; status: "ok" | "warning" | "exceeded" | "unconfigured"; spentUsd?: number; monthlyBudgetUsd?: number }>) {
  return {
    generatedAt: new Date().toISOString(),
    month: "2026-07",
    providers: providers.map((p) => ({
      name: p.name,
      status: p.status,
      monthlyBudgetUsd: p.monthlyBudgetUsd ?? 100,
      spentUsd: p.spentUsd ?? 0,
      remainingUsd: null,
      percentUsed: null
    })),
    summary: {
      totalBudgetUsd: 100,
      totalSpentUsd: 0,
      remainingUsd: 100,
      percentUsed: 0,
      overBudget: providers.some((p) => p.status === "exceeded"),
      warning: providers.some((p) => p.status === "warning")
    }
  };
}

/** Build the fetch stub. Routes OpenAI, the usage-monitor budget-status GET, and the nasdaq scan. */
function makeFetchStub(opts: {
  redTeamVerdict: { rejected: boolean; reason: string };
  bullProposals?: unknown[];
  onOpenAiBody?: (body: any) => void;
  budgetProviders?: Array<{ name: string; status: "ok" | "warning" | "exceeded" | "unconfigured"; spentUsd?: number; monthlyBudgetUsd?: number }>;
  budgetStatusUnavailable?: boolean;
}) {
  const proposals = opts.bullProposals ?? [BULL_PROPOSAL];
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes(`${BASE}/api/budget-status`)) {
      if (opts.budgetStatusUnavailable) return new Response("error", { status: 500 });
      return new Response(JSON.stringify(budgetStatusPayload(opts.budgetProviders ?? [{ name: "openai", status: "ok" }])), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("api.openai.com")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      opts.onOpenAiBody?.(body);
      const systemContent = JSON.stringify(body);
      if (systemContent.includes("Red Team Risk Agent")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(opts.redTeamVerdict) } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
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

async function seedTestAccountAndPolicy(overrides: Record<string, unknown> = {}) {
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
    llmModel: "gpt-4o",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    ...overrides
  });
}

describe("usage-budget Phase 2: advisory (USAGE_BUDGET_ENFORCE off)", () => {
  it("makes no model change, writes a usage_budget_status receipt, and surfaces the advisory line in the Bull prompt", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    let bullBody: any;
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        redTeamVerdict: { rejected: false, reason: "No fatal flaw found." },
        budgetProviders: [{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }],
        onOpenAiBody: (body) => {
          const content = JSON.stringify(body);
          if (!content.includes("Red Team Risk Agent") && !bullBody) bullBody = body;
        }
      })
    );

    await seedTestAccountAndPolicy();
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // usage_budget_status receipt is written every run when the monitor is configured, regardless
    // of the enforce flag.
    const statusAudits = listAudit(500).filter((e) => e.kind === "usage_budget_status");
    expect(statusAudits.length).toBeGreaterThanOrEqual(1);
    const statusPayload = statusAudits[0].payload as { enforceOn?: boolean; wouldDowngrade?: boolean; wouldSkip?: boolean };
    expect(statusPayload.enforceOn).toBe(false);
    // Over-budget openai WOULD be downgraded/skipped if enforcement were on — recorded as advisory data.
    expect(statusPayload.wouldDowngrade || statusPayload.wouldSkip).toBe(true);

    // No enforcement receipt should exist since USAGE_BUDGET_ENFORCE is off.
    expect(listAudit(500).filter((e) => e.kind === "usage_budget_enforced").length).toBe(0);

    // The model actually served was NOT downgraded — the persisted proposal carries the ORIGINAL model.
    const proposals = listRecentProposals("TEST", 100, "local");
    const aaplProposal = proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal?.proposal.proposedByModel).toBe("gpt-4o");

    // The advisory line reached the Bull's userContent, next to drawdownAdvisory.
    expect(bullBody).toBeDefined();
    const bullUserMessage = bullBody.messages?.find((m: any) => m.role === "user") ?? bullBody.input?.find((m: any) => m.role === "user");
    const bullUserContent = typeof bullUserMessage?.content === "string" ? bullUserMessage.content : JSON.stringify(bullUserMessage?.content ?? bullBody);
    expect(bullUserContent).toContain("budgetAdvisory");
    expect(bullUserContent).toContain("openai");
  }, 30_000);
});

describe("usage-budget Phase 2: enforcement ON + downgrade", () => {
  it("swaps llmModel/redTeamLlmModel for this run only and writes a usage_budget_enforced receipt", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.USAGE_BUDGET_ENFORCE = "on";
    let bullModelUsed: string | undefined;
    let redTeamModelUsed: string | undefined;
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        redTeamVerdict: { rejected: false, reason: "No fatal flaw found." },
        budgetProviders: [{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }],
        onOpenAiBody: (body) => {
          const content = JSON.stringify(body);
          if (content.includes("Red Team Risk Agent")) {
            // Finding 6: capture the Red Team (Bear) request body too, proving debateProposal's
            // policyOverride threading carries the downgraded redTeamLlmModel end-to-end (not just
            // the Bull/proposeTrades path).
            if (typeof body.model === "string" && !redTeamModelUsed) redTeamModelUsed = body.model;
            return;
          }
          if (typeof body.model === "string" && !bullModelUsed) {
            bullModelUsed = body.model;
          }
        }
      })
    );

    // gpt-4o has a known cheaper tier (gpt-4o-mini) in CHEAPER_MODEL.
    await seedTestAccountAndPolicy({ llmModel: "gpt-4o", redTeamLlmModel: "gpt-4o" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals, getPolicy } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const enforcedAudits = listAudit(500).filter((e) => e.kind === "usage_budget_enforced");
    expect(enforcedAudits.length).toBeGreaterThanOrEqual(1);
    const payload = enforcedAudits[0].payload as { action?: string; before?: { llmModel?: string }; after?: { llmModel?: string } };
    expect(payload.action).toBe("downgrade");
    expect(payload.before?.llmModel).toBe("gpt-4o");
    expect(payload.after?.llmModel).toBe("gpt-4o-mini");

    // The model actually used for the Bull call was the downgraded one.
    expect(bullModelUsed).toBe("gpt-4o-mini");
    // Finding 6: the Bear (Red Team) request also carried the downgraded model.
    expect(redTeamModelUsed).toBe("gpt-4o-mini");

    // The persisted proposal reflects the served (downgraded) model.
    const proposals = listRecentProposals("TEST", 100, "local");
    const aaplProposal = proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal?.proposal.proposedByModel).toBe("gpt-4o-mini");

    // The downgrade was NOT persisted — the saved policy still has the owner's original model.
    const savedPolicy = getPolicy("local");
    expect(savedPolicy.llmModel).toBe("gpt-4o");
    expect(savedPolicy.redTeamLlmModel).toBe("gpt-4o");
  }, 30_000);

  it("FINDING 1 regression: a cap-breach demotion in the SAME run persists strategyAuthority only — never the in-run model downgrade", async () => {
    // This run BOTH downgrades (over-budget openai) AND trips a cap-breach demotion
    // (maxDailyOrders: 0 under strategyAuthority "decide" escalates and demotes to "propose").
    // Before the fix, autoRevertOnCapBreach's `setPolicy({ ...policy, strategyAuthority: "propose" })`
    // would persist the mutated policy.llmModel/redTeamLlmModel too, since strategy.ts mutated the
    // shared `policy` object in place. After the fix, the downgrade lives only on a separate
    // `runPolicy` never passed to setPolicy, so the persisted row must show the downgrade GONE but
    // the demotion applied.
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.USAGE_BUDGET_ENFORCE = "on";
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        redTeamVerdict: { rejected: false, reason: "No fatal flaw found." },
        budgetProviders: [{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }]
      })
    );

    // gpt-4o has a known cheaper tier (gpt-4o-mini) in CHEAPER_MODEL.
    await seedTestAccountAndPolicy({
      llmModel: "gpt-4o",
      redTeamLlmModel: "gpt-4o",
      strategyAuthority: "decide",
      maxDailyOrders: 0
    });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, getPolicy } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // The downgrade actually happened this run.
    const enforcedAudits = listAudit(500).filter((e) => e.kind === "usage_budget_enforced");
    expect(enforcedAudits.some((e) => (e.payload as { action?: string }).action === "downgrade")).toBe(true);

    // The cap-breach demotion also happened this run.
    const capBreachAudits = listAudit(500).filter((e) => e.kind === "policy_violation_cap_exceeded");
    expect(capBreachAudits.length).toBeGreaterThanOrEqual(1);
    const capPayload = capBreachAudits[0].payload as { from?: string; revertedTo?: string };
    expect(capPayload.from).toBe("decide");
    expect(capPayload.revertedTo).toBe("propose");

    // The persisted policy reflects BOTH correctly: strategyAuthority demoted, but llmModel/
    // redTeamLlmModel are the ORIGINAL owner-configured models — the downgrade never persisted.
    const savedPolicy = getPolicy("local");
    expect(savedPolicy.strategyAuthority).toBe("propose");
    expect(savedPolicy.llmModel).toBe("gpt-4o");
    expect(savedPolicy.redTeamLlmModel).toBe("gpt-4o");
  }, 30_000);
});

describe("usage-budget Phase 2: enforcement ON + skip", () => {
  it("ends the run before any LLM call and writes a receipt (no OpenAI call observed)", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.USAGE_BUDGET_ENFORCE = "on";
    let openAiCalled = false;
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        redTeamVerdict: { rejected: false, reason: "n/a" },
        // gpt-4o-mini already the cheapest OpenAI tier in CHEAPER_MODEL -> skip, not downgrade.
        budgetProviders: [{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }],
        onOpenAiBody: () => {
          openAiCalled = true;
        }
      })
    );

    await seedTestAccountAndPolicy({ llmModel: "gpt-4o-mini" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listFillEvents, listNotificationEvents } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");
    expect(openAiCalled).toBe(false);

    const enforcedAudits = listAudit(500).filter((e) => e.kind === "usage_budget_enforced");
    expect(enforcedAudits.length).toBeGreaterThanOrEqual(1);
    const payload = enforcedAudits[0].payload as { action?: string; reason?: string };
    expect(payload.action).toBe("skip");
    expect(payload.reason).toBeTruthy();

    // notifyBudgetSkip fired a notification.
    const notifications = listNotificationEvents("local", 100);
    expect(notifications.some((n) => n.type === "budget_alert")).toBe(true);

    // No proposal/fill was ever generated for this run.
    expect(listFillEvents("TEST", undefined, 100, "local").find((f) => f.symbol === "AAPL")).toBeUndefined();
  }, 30_000);
});

describe("usage-budget Phase 2: evaluator failure fails open", () => {
  it("proceeds untouched (no crash, no downgrade, no skip) when the budget-status fetch errors", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.USAGE_BUDGET_ENFORCE = "on";
    vi.stubGlobal(
      "fetch",
      makeFetchStub({
        redTeamVerdict: { rejected: false, reason: "No fatal flaw found." },
        budgetStatusUnavailable: true
      })
    );

    await seedTestAccountAndPolicy({ llmModel: "gpt-4o" });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listFillEvents, listRecentProposals } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // No enforcement or status receipt — the monitor call failed, fail-open means no assertion made.
    expect(listAudit(500).filter((e) => e.kind === "usage_budget_enforced").length).toBe(0);
    expect(listAudit(500).filter((e) => e.kind === "usage_budget_status").length).toBe(0);

    // The run proceeded normally end-to-end: proposal generated, fill booked, original model served.
    const fills = listFillEvents("TEST", undefined, 100, "local");
    expect(fills.find((f) => f.symbol === "AAPL")).toBeDefined();
    const proposals = listRecentProposals("TEST", 100, "local");
    expect(proposals.find((p) => p.proposal.symbol === "AAPL")?.proposal.proposedByModel).toBe("gpt-4o");
  }, 30_000);
});

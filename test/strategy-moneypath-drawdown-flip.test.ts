import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
process.env.OPENROUTER_API_KEY = "test-key";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// G5 regression: the drawdown kill-switch WIRING inside runStrategyOnce.
//
// The pure/stateful breaker math is covered by test/risk-breaker.test.ts. This test covers the
// missing piece: that an autonomous, `active` run which observes an equity drop below the persisted
// high-water mark actually (a) flips systemState via setPolicy per riskRules.drawdownBreakerAction
// (default "halt" → "halted"; overridable to "close_only"), and (b) writes an
// audit("policy_violation_drawdown") row — i.e. the breaker wiring is correct and durable
// (the HWM is read from the settings KV persisted across "restarts"). NEVER places a real trade.
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
  storeContexts: async () => {},
  getCurrentVectorProviderAuthority: () => "test-provider",
  managedVectorLedgerAuthority: () => "test-ledger"
}));

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-drawdown-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

function zeroProposalFetchStub() {
  return async (url: string | URL | Request) => {
    const href = String(url);
    if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals: [] }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) {
      return new Response(
        JSON.stringify({
          data: {
            asof: "2026-06-30",
            table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("runStrategyOnce drawdown kill-switch wiring (G5)", () => {
  it("is ADVISORY by default: on a breach it audits a receipt and does NOT change systemState", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, getPolicy, listAudit } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");

    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    // Persist a HIGH high-water mark for (local, TEST, paper) — as if a prior session peaked at
    // $250k. This lives in the settings KV, i.e. it survives a "restart" (a fresh module import).
    // The test-sim account equity is $100k, so the run observes a ~60% drawdown from this peak.
    const seeded = recordAndEvaluateDrawdownBreaker({
      accountNumber: "TEST",
      source: "paper",
      equity: 250_000,
      riskRules: { maxDrawdownPct: 20 },
      userId: "local"
    });
    expect(seeded.highWaterMark).toBe(250_000);
    expect(seeded.breached).toBe(false); // seeding the peak itself never breaches

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      // No drawdownBreakerAction set → default "advisory" (receipt + agent context, no state change).
      riskRules: { ...DEFAULT_POLICY.riskRules, maxDrawdownPct: 20 }
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // (a) ADVISORY default: systemState is UNCHANGED (stays "active"). The breaker informs the agent,
    // it never seizes control — "nothing is hard except which account to work in; agent decides, logs
    // everything." Hard enforcement is opt-in only (see the close_only/halt tests below).
    expect(getPolicy("local").systemState).toBe("active");

    // (b) the breach was still logged as a receipt, tagged action "advisory", with NO state transition.
    const drawdownAudits = listAudit(500).filter((e) => e.kind === "policy_violation_drawdown");
    expect(drawdownAudits.length).toBeGreaterThanOrEqual(1);
    const payload = drawdownAudits[0].payload as { from?: string; revertedTo?: string; action?: string; highWaterMark?: number };
    expect(payload.from).toBe("active");
    expect(payload.action).toBe("advisory");
    expect(payload.revertedTo).toBeUndefined();
    expect(payload.highWaterMark).toBe(250_000);
  }, 75_000);

  it("honors the overridable drawdownBreakerAction: 'close_only' (softer — only blocks new entries)", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, getPolicy, listAudit } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");

    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    const seeded = recordAndEvaluateDrawdownBreaker({ accountNumber: "TEST", source: "paper", equity: 250_000, riskRules: { maxDrawdownPct: 20 }, userId: "local" });
    expect(seeded.breached).toBe(false);

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      riskRules: { ...DEFAULT_POLICY.riskRules, maxDrawdownPct: 20, drawdownBreakerAction: "close_only" }
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    // Overridden to the softer response → "close_only", not "halted".
    expect(getPolicy("local").systemState).toBe("close_only");
    const payload = listAudit(500).filter((e) => e.kind === "policy_violation_drawdown")[0]?.payload as { revertedTo?: string; action?: string };
    expect(payload.revertedTo).toBe("close_only");
    expect(payload.action).toBe("close_only");
  }, 75_000);

  it("does NOT flip when no drawdown limit is configured (default-safe)", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, getPolicy, listAudit } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");

    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    // Seed a high peak but WITHOUT a maxDrawdownPct limit → the breaker is a no-op even on a big drop.
    recordAndEvaluateDrawdownBreaker({ accountNumber: "TEST", source: "paper", equity: 250_000, riskRules: {}, userId: "local" });

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      // maxDrawdownPct pinned to 0: DEFAULT_RISK_RULES gained a 15% advisory default on 2026-07-28
      // (guard enablement), and mergePolicy would inject it back into a bare {} — 0 explicitly
      // disables the breaker so this test keeps covering the no-limit path.
      riskRules: { maxDrawdownPct: 0 } // no drawdown/daily-loss limits
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    expect(getPolicy("local").systemState).toBe("active"); // unchanged
    expect(listAudit(500).filter((e) => e.kind === "policy_violation_drawdown").length).toBe(0);
  }, 75_000);
});

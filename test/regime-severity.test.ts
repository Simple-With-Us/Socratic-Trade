/**
 * Lane 5 — multi-signal regime severity scorer.
 *
 * Two groups:
 *   1. Pure unit tests of `computeMultiSignalSeverity` — normalization endpoints/midpoints,
 *      weight renormalization over missing inputs, the enum-severity floor, zero-input collapse,
 *      and monotonicity spot checks.
 *   2. A strategy.ts wiring test (modeled on test/strategy-rag-quickwins-wiring.test.ts and
 *      test/redteam-observability-g10.test.ts): asserts the prompt's userContent carries a
 *      compact `regimeSeverity` block next to `currentMarketRegime` when inputs are available,
 *      that the persisted proposal is stamped with `entryRegimeSeverity`, and that a scorer
 *      throw does not fail the run (best-effort).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeMultiSignalSeverity } from "../src/lib/regime-severity";
import { DEFAULT_POLICY } from "../src/lib/defaults";

describe("computeMultiSignalSeverity — normalization", () => {
  it("vix: 0 at <=12, 1 at >=40, 0.5 at the midpoint (26)", () => {
    expect(computeMultiSignalSeverity({ regime: "unknown", vix: 12 }).components[0]!.normalized).toBe(0);
    expect(computeMultiSignalSeverity({ regime: "unknown", vix: 40 }).components[0]!.normalized).toBe(1);
    expect(computeMultiSignalSeverity({ regime: "unknown", vix: 26 }).components[0]!.normalized).toBeCloseTo(0.5, 5);
    // Clamped beyond the endpoints.
    expect(computeMultiSignalSeverity({ regime: "unknown", vix: 5 }).components[0]!.normalized).toBe(0);
    expect(computeMultiSignalSeverity({ regime: "unknown", vix: 60 }).components[0]!.normalized).toBe(1);
  });

  it("vixTermStructure: 0 at <=0.85, 1 at >=1.10, midpoint 0.975", () => {
    const at0 = computeMultiSignalSeverity({ regime: "unknown", vixTermStructure: 0.85 });
    const at1 = computeMultiSignalSeverity({ regime: "unknown", vixTermStructure: 1.1 });
    const mid = computeMultiSignalSeverity({ regime: "unknown", vixTermStructure: 0.975 });
    expect(at0.components[0]!.normalized).toBe(0);
    expect(at1.components[0]!.normalized).toBe(1);
    expect(mid.components[0]!.normalized).toBeCloseTo(0.5, 5);
  });

  it("hyCreditSpreadPct: 0 at <=3.0, 1 at >=8.0, midpoint 5.5", () => {
    const at0 = computeMultiSignalSeverity({ regime: "unknown", hyCreditSpreadPct: 3.0 });
    const at1 = computeMultiSignalSeverity({ regime: "unknown", hyCreditSpreadPct: 8.0 });
    const mid = computeMultiSignalSeverity({ regime: "unknown", hyCreditSpreadPct: 5.5 });
    expect(at0.components[0]!.normalized).toBe(0);
    expect(at1.components[0]!.normalized).toBe(1);
    expect(mid.components[0]!.normalized).toBeCloseTo(0.5, 5);
  });

  it("breadthPct: INVERTED — 0 at >=60, 1 at <=25, midpoint 42.5", () => {
    const calm = computeMultiSignalSeverity({ regime: "unknown", breadthPct: 60 });
    const stressed = computeMultiSignalSeverity({ regime: "unknown", breadthPct: 25 });
    const mid = computeMultiSignalSeverity({ regime: "unknown", breadthPct: 42.5 });
    expect(calm.components[0]!.normalized).toBe(0);
    expect(stressed.components[0]!.normalized).toBe(1);
    expect(mid.components[0]!.normalized).toBeCloseTo(0.5, 5);
    // Very low breadth stays clamped at 1 (never negative/over 1).
    expect(computeMultiSignalSeverity({ regime: "unknown", breadthPct: 5 }).components[0]!.normalized).toBe(1);
  });

  it("vvix: 0 at <=80, 1 at >=140, midpoint 110", () => {
    const at0 = computeMultiSignalSeverity({ regime: "unknown", vvix: 80 });
    const at1 = computeMultiSignalSeverity({ regime: "unknown", vvix: 140 });
    const mid = computeMultiSignalSeverity({ regime: "unknown", vvix: 110 });
    expect(at0.components[0]!.normalized).toBe(0);
    expect(at1.components[0]!.normalized).toBe(1);
    expect(mid.components[0]!.normalized).toBeCloseTo(0.5, 5);
  });

  it("skew: 0 at <=115, 1 at >=155, midpoint 135", () => {
    const at0 = computeMultiSignalSeverity({ regime: "unknown", skew: 115 });
    const at1 = computeMultiSignalSeverity({ regime: "unknown", skew: 155 });
    const mid = computeMultiSignalSeverity({ regime: "unknown", skew: 135 });
    expect(at0.components[0]!.normalized).toBe(0);
    expect(at1.components[0]!.normalized).toBe(1);
    expect(mid.components[0]!.normalized).toBeCloseTo(0.5, 5);
  });
});

describe("computeMultiSignalSeverity — weight renormalization", () => {
  it("only vix present -> its renormalized weight is 1.0 and severity equals its normalized value", () => {
    const result = computeMultiSignalSeverity({ regime: "unknown", vix: 40 }); // normalized 1
    expect(result.inputsUsed).toBe(1);
    expect(result.inputsAvailable).toBe(6);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({ signal: "vix", normalized: 1, weight: 1 });
    expect(result.severity).toBe(1);
  });

  it("vix + breadthPct present -> weights renormalize to their relative shares (0.3 / 0.15 -> 2/3, 1/3)", () => {
    const result = computeMultiSignalSeverity({ regime: "unknown", vix: 40, breadthPct: 25 }); // both normalized to 1
    expect(result.inputsUsed).toBe(2);
    const vixComp = result.components.find((c) => c.signal === "vix")!;
    const breadthComp = result.components.find((c) => c.signal === "breadthPct")!;
    expect(vixComp.weight).toBeCloseTo(0.3 / 0.45, 5);
    expect(breadthComp.weight).toBeCloseTo(0.15 / 0.45, 5);
    // Both signals maxed out at 1 -> blend is 1 regardless of weight split.
    expect(result.severity).toBeCloseTo(1, 5);
  });

  it("all six present -> weights match the base weights exactly (already sum to 1)", () => {
    const result = computeMultiSignalSeverity({
      regime: "unknown",
      vix: 12,
      vixTermStructure: 0.85,
      hyCreditSpreadPct: 3.0,
      breadthPct: 60,
      vvix: 80,
      skew: 115
    });
    expect(result.inputsUsed).toBe(6);
    const weights = Object.fromEntries(result.components.map((c) => [c.signal, c.weight]));
    // Weights are renormalized by dividing by a floating-point sum, so assert with tolerance —
    // exact float equality would be brittle across engines/rounding. All six present → sum is 1.0.
    expect(weights.vix).toBeCloseTo(0.3, 10);
    expect(weights.vixTermStructure).toBeCloseTo(0.2, 10);
    expect(weights.hyCreditSpreadPct).toBeCloseTo(0.2, 10);
    expect(weights.breadthPct).toBeCloseTo(0.15, 10);
    expect(weights.vvix).toBeCloseTo(0.1, 10);
    expect(weights.skew).toBeCloseTo(0.05, 10);
    // All calm -> severity is the floor (0 for "unknown").
    expect(result.severity).toBe(0);
  });
});

describe("computeMultiSignalSeverity — enum floor", () => {
  it("crisis regime + entirely benign signals still reads severity 1 (the crisis floor)", () => {
    const result = computeMultiSignalSeverity({
      regime: "crisis",
      vix: 12,
      vixTermStructure: 0.85,
      hyCreditSpreadPct: 3.0,
      breadthPct: 60,
      vvix: 80,
      skew: 115
    });
    expect(result.floor).toBe(1);
    // Blend of all-calm signals would be 0, but the crisis floor forces severity to 1.
    expect(result.severity).toBe(1);
  });

  it("risk-on regime + terrible signals reads the pure blend (floor is 0, no floor interference)", () => {
    const result = computeMultiSignalSeverity({
      regime: "risk-on",
      vix: 40,
      vixTermStructure: 1.1,
      hyCreditSpreadPct: 8.0,
      breadthPct: 25,
      vvix: 140,
      skew: 155
    });
    expect(result.floor).toBe(0);
    expect(result.severity).toBeCloseTo(1, 5); // all signals maxed -> blend is 1 too, but via the blend not the floor
  });

  it("risk-off regime (floor 0.66) + mild signals: severity is max(floor, blend) — floor wins when blend is lower", () => {
    const result = computeMultiSignalSeverity({ regime: "risk-off", vix: 20 }); // vix=20 normalizes to 8/28 ≈ 0.286
    expect(result.floor).toBe(0.66);
    expect(result.components[0]!.normalized).toBeCloseTo(8 / 28, 5);
    expect(result.severity).toBe(0.66); // floor dominates a milder blend
  });

  it("risk-off regime + severe signals: blend can exceed the floor", () => {
    const result = computeMultiSignalSeverity({ regime: "risk-off", vix: 40 }); // normalized 1 > floor 0.66
    expect(result.severity).toBe(1);
  });
});

describe("computeMultiSignalSeverity — zero inputs", () => {
  it("no continuous inputs at all -> severity is exactly the enum floor, inputsUsed 0", () => {
    const crisis = computeMultiSignalSeverity({ regime: "crisis" });
    expect(crisis.inputsUsed).toBe(0);
    expect(crisis.components).toHaveLength(0);
    expect(crisis.severity).toBe(1);
    expect(crisis.floor).toBe(1);

    const neutral = computeMultiSignalSeverity({ regime: "neutral" });
    expect(neutral.inputsUsed).toBe(0);
    expect(neutral.severity).toBe(0);
  });
});

describe("computeMultiSignalSeverity — monotonicity", () => {
  it("severity is non-decreasing as vix rises, holding regime fixed", () => {
    const low = computeMultiSignalSeverity({ regime: "neutral", vix: 15 }).severity;
    const mid = computeMultiSignalSeverity({ regime: "neutral", vix: 25 }).severity;
    const high = computeMultiSignalSeverity({ regime: "neutral", vix: 35 }).severity;
    expect(low).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(high);
  });

  it("severity is non-decreasing as breadth falls (stress rises), holding regime fixed", () => {
    const calm = computeMultiSignalSeverity({ regime: "neutral", breadthPct: 70 }).severity;
    const mid = computeMultiSignalSeverity({ regime: "neutral", breadthPct: 45 }).severity;
    const stressed = computeMultiSignalSeverity({ regime: "neutral", breadthPct: 20 }).severity;
    expect(calm).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(stressed);
  });

  it("enum floor ordering is preserved with identical (or absent) continuous signals", () => {
    const crisis = computeMultiSignalSeverity({ regime: "crisis" }).severity;
    const riskOff = computeMultiSignalSeverity({ regime: "risk-off" }).severity;
    const cautious = computeMultiSignalSeverity({ regime: "cautious-inverted" }).severity;
    const neutral = computeMultiSignalSeverity({ regime: "neutral" }).severity;
    expect(crisis).toBeGreaterThan(riskOff);
    expect(riskOff).toBeGreaterThan(cautious);
    expect(cautious).toBeGreaterThan(neutral);
  });
});

// ---------------------------------------------------------------------------------------------
// Wiring: strategy.ts prompt assembly + proposal stamping.
// ---------------------------------------------------------------------------------------------

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.35,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {},
  getCurrentVectorProviderAuthority: () => "test-provider",
  managedVectorLedgerAuthority: () => "test-ledger"
}));

// Deterministic, network-free macro + market-signals fan-out so `regimeSeverity` is a known,
// non-trivial value: VIX 32 (crisis-adjacent), backwardated term structure, wide HY spread, weak
// breadth — all continuous inputs available.
vi.mock("../src/lib/macro", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/macro")>();
  const stubMacro = {
    fedFundsRate: "5.25%",
    dgs3moTreasury: "5.10%",
    dgs2Treasury: "4.60%",
    dgs10Treasury: "4.20%",
    inflationExpectation10y: "2.30%",
    cpiInflation: "3.10%",
    corePCE: "2.80%",
    realGDPGrowth: "2.00%",
    unemploymentRate: "3.90%",
    initialClaims: "220K",
    m2MoneySupply: "20.8T",
    m2GrowthYoY: "2.50%",
    hyCreditSpread: "6.50%",
    usdIndex: "121.00",
    wtiOil: "$75.00",
    housingStarts: "1.3M",
    consumerSentiment: "75.0",
    vix: "32.00",
    vix3m: "27.00", // vix/vix3m ≈ 1.185 -> backwardation
    asOf: "2026-07-05"
  };
  return {
    ...actual,
    fetchMacroData: async () => stubMacro,
    fetchMacroDataWithLiveVix: async () => stubMacro
  };
});
vi.mock("../src/lib/market-signals", () => ({
  getMarketSignals: async () => ({ marketBreadthPct: 30, vvix: 100, skew: 120 })
}));

const PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 50,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Test proposal for regime-severity wiring.",
  tradeThesisTag: "Momentum",
  entryMarketRegime: "placeholder-overwritten-by-strategy",
  confidenceScore: 60
};

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-07-05",
        table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function isRedTeamRequest(body: unknown): boolean {
  return JSON.stringify(body).includes("Red Team Risk Agent");
}

function bullPromptBody(openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }>): { input?: Array<{ role: string; content: string }> } {
  const body = openAiBodies.find((candidate) => (
    candidate.input?.some((item) => item.role === "system" && item.content.includes("autonomous equity trading agent"))
  ));
  if (!body) throw new Error("Bull strategy prompt was not captured");
  return body;
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-regime-severity-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

async function seed(options: { regimeSeverityScoring?: boolean } = {}) {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Regime Severity Test", isActive: true });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "openai/gpt-4.1-mini",
    redTeamLlmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    ...(options.regimeSeverityScoring
      ? { tuning: { ...DEFAULT_POLICY.tuning, regimeSeverityScoring: true } }
      : {})
  });
}

describe("strategy.ts regime-severity wiring", () => {
  it("policy.tuning.regimeSeverityScoring default OFF: no regimeSeverity in userContent, no entryRegimeSeverity stamp (byte-identical default)", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        openAiBodies.push(body);
        if (isRedTeamRequest(body)) {
          return new Response(
            JSON.stringify({ output_text: JSON.stringify({ verdict: "approve", reason: "No fatal flaw found." }) }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [PROPOSAL] }) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    // Default seed — tuning.regimeSeverityScoring left unset (default false).
    await seed();
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const bullBody = bullPromptBody(openAiBodies);
    const userContent = JSON.parse(bullBody.input!.find((item) => item.role === "user")?.content ?? "{}");
    expect(userContent.currentMarketRegime).toBeDefined();
    expect(userContent.regimeSeverity).toBeUndefined();
    expect(result.proposals[0]?.proposal.entryRegimeSeverity).toBeUndefined();
  }, 75_000);

  it("policy.tuning.regimeSeverityScoring ON: includes a compact regimeSeverity block in userContent next to currentMarketRegime, and stamps entryRegimeSeverity on the persisted proposal", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    let strategyCallCount = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        strategyCallCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}"));
        openAiBodies.push(body);
        if (isRedTeamRequest(body)) {
          return new Response(
            JSON.stringify({ output_text: JSON.stringify({ verdict: "approve", reason: "No fatal flaw found." }) }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // First call is Bull, second is Bear — both echo the same proposal back.
        return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [PROPOSAL] }) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    await seed({ regimeSeverityScoring: true });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    expect(strategyCallCount).toBeGreaterThanOrEqual(1);

    const bullBody = bullPromptBody(openAiBodies);
    const userContent = JSON.parse(bullBody.input!.find((item) => item.role === "user")?.content ?? "{}");
    expect(userContent.currentMarketRegime).toBeDefined();
    expect(userContent.regimeSeverity).toBeDefined();
    expect(userContent.regimeSeverity.inputsUsed).toBe(6);
    expect(userContent.regimeSeverity.inputsAvailable).toBe(6);
    expect(userContent.regimeSeverity.severity).toBeGreaterThan(0);
    expect(Array.isArray(userContent.regimeSeverity.topComponents)).toBe(true);
    expect(userContent.regimeSeverity.topComponents.length).toBeLessThanOrEqual(3);
    expect(userContent.regimeSeverity.topComponents.length).toBeGreaterThan(0);

    // The persisted proposal (from the strategy result, matching what listPendingProposals would
    // read back) carries the rounded severity value alongside entryMarketRegime.
    const persisted = result.proposals[0]?.proposal;
    expect(persisted).toBeDefined();
    expect(typeof persisted!.entryRegimeSeverity).toBe("number");
    expect(persisted!.entryRegimeSeverity).toBeGreaterThan(0);
    expect(persisted!.entryRegimeSeverity).toBeLessThanOrEqual(1);
  }, 75_000);

  it("policy.tuning.regimeSeverityScoring ON, scorer throws: does not fail the run — no regimeSeverity in userContent, proposal still generated", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.doMock("../src/lib/regime-severity", () => ({
      computeMultiSignalSeverity: () => {
        throw new Error("boom");
      }
    }));

    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        openAiBodies.push(body);
        if (isRedTeamRequest(body)) {
          return new Response(
            JSON.stringify({ output_text: JSON.stringify({ verdict: "approve", reason: "No fatal flaw found." }) }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [PROPOSAL] }) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    await seed({ regimeSeverityScoring: true });
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    const bullBody = bullPromptBody(openAiBodies);
    const userContent = JSON.parse(bullBody.input!.find((item) => item.role === "user")?.content ?? "{}");
    expect(userContent.regimeSeverity).toBeUndefined();
    expect(result.proposals[0]?.proposal.entryRegimeSeverity).toBeUndefined();
  }, 75_000);
});

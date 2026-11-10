import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// G10: observability stamping (updated for the 2026-07-07 single-adversary consolidation — the
// in-flow Bear generation no longer exists).
//
// Asserts that:
//   1. The bull generation AND the single Red Team review generation carry metadata.promptVersion
//      sourced from the single STRATEGY_PROMPT_VERSION constant.
//   2. The review generation's output mapper stamps the verdict.
//   3. A rationale diversity-collapse emits a stamped recordDecisionObservation.
//
// We mock ../src/lib/observability so `withLlmGeneration` still runs its callback (no behavior
// change) but records every options object, and `recordDecisionObservation` is a spy. This proves
// the stamping without needing a live Langfuse endpoint (the real helpers are hard no-ops when
// Langfuse is unconfigured, so nothing is emitted otherwise).

const generationOptions: Array<{ name: string; metadata?: Record<string, unknown>; output?: (r: unknown) => unknown }> = [];
const decisionObservations: Array<{ name: string; metadata?: Record<string, unknown>; tags?: string[] }> = [];

vi.mock("../src/lib/observability", () => ({
  startObservability: async () => {},
  withLlmGeneration: async (options: any, run: () => Promise<unknown>) => {
    generationOptions.push({ name: options.name, metadata: options.metadata, output: options.output });
    return run();
  },
  recordDecisionObservation: async (options: any) => {
    decisionObservations.push({ name: options.name, metadata: options.metadata, tags: options.tags });
  }
}));

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

beforeEach(() => {
  vi.resetModules();
  generationOptions.length = 0;
  decisionObservations.length = 0;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-obs-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

// Two near-identical proposals so the post-gate rationale-diversity check collapses. (Every
// risk-adding opening is reviewed now — no conviction gating.)
const COLLAPSED_PROPOSAL = (symbol: string) => ({
  symbol,
  side: "buy",
  type: "market",
  dollarAmount: 50,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Momentum breakout with strong volume confirmation and constructive base.",
  tradeThesisTag: "Momentum",
  entryMarketRegime: "Neutral (Normal Volatility)",
  confidenceScore: 90
});

function makeFetchStub() {
  const bullProposals = [COLLAPSED_PROPOSAL("AAPL"), COLLAPSED_PROPOSAL("MSFT")];
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
      const body = init?.body ? String(init.body) : "{}";
      if (body.includes("Red Team Risk Agent") || body.includes("red_team_verdict")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "ok" }) } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: bullProposals }) }), {
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
                { symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" },
                { symbol: "MSFT", lastsale: "$400", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Software" }
              ]
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (href.includes("sec.gov/files/company_tickers.json")) {
      return new Response(JSON.stringify({ "0": { "ticker": "AAPL", "title": "Apple Inc.", "cik_str": 320193 }, "1": { "ticker": "MSFT", "title": "Microsoft Corp", "cik_str": 789019 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
}

async function seed() {
  const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "t");
  const id = randomUUID();
  upsertConnectedAccount({ id, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test", isActive: true });
  setActiveConnectedAccount(id);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "openai/gpt-4.1-mini",
    redTeamLlmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL", "MSFT"],
    strategyAuthority: "decide"
  });
}

describe("observability stamping (G10)", () => {
  it("stamps promptVersion on the bull + red-team review generations, a verdict in the review output, and a diversity-collapse observation", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", makeFetchStub());

    await seed();
    const { runStrategyOnce, STRATEGY_PROMPT_VERSION } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // (1) The bull generation carries the promptVersion constant; the in-flow Bear generation is
    //     GONE (single-adversary consolidation).
    const bull = generationOptions.find((g) => g.name === "trading.strategy.bull");
    expect(bull?.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);
    expect(generationOptions.find((g) => g.name === "trading.strategy.bear")).toBeUndefined();

    // The single Red Team review generation was traced AND stamped with the same promptVersion —
    // once per risk-adding opening (universal coverage: both AAPL and MSFT).
    const reviews = generationOptions.filter((g) => g.name === "trading.red-team.review");
    expect(reviews.length).toBe(2);
    for (const review of reviews) expect(review.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);

    // (2) The review output mapper stamps the verdict fields.
    const reviewOut = reviews[0]?.output?.({
      text: "{}",
      debate: { verdict: "reject", rejected: true, available: true, reason: "flawed" }
    }) as { verdict?: string; rejected?: boolean } | undefined;
    expect(reviewOut?.verdict).toBe("reject");
    expect(reviewOut?.rejected).toBe(true);

    // (3) The diversity-collapse observation was emitted with a stamped promptVersion + tag.
    const collapse = decisionObservations.find((o) => o.name === "trading.strategy.diversity-collapse");
    expect(collapse).toBeDefined();
    expect(collapse?.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);
    expect(collapse?.tags).toContain("diversity-collapse");

    // (4) The completed run records its graph trajectory (run id, transitions, final state).
    const trajectory = decisionObservations.find((o) => o.name === "trading.strategy.graph-trajectory");
    expect(trajectory).toBeDefined();
    expect(trajectory?.tags).toContain("graph-trajectory");
    expect(trajectory?.metadata?.runId).toBe(result.runId);
    expect(trajectory?.metadata?.graphFinalState).toBe("COMPLETED");
    const recordedTransitions = trajectory?.metadata?.graphTransitions;
    expect(Array.isArray(recordedTransitions)).toBe(true);
    if (!Array.isArray(recordedTransitions)) {
      throw new Error("graphTransitions has an unexpected shape");
    }
    expect(recordedTransitions.length).toBeGreaterThan(0);
    expect(recordedTransitions[0]).toEqual(expect.objectContaining({
      from: "INIT",
      durationMs: expect.any(Number),
      timestamp: expect.any(Number)
    }));
    expect(recordedTransitions.at(-1)).toEqual(expect.objectContaining({ to: "COMPLETED" }));
  }, 30_000);
});

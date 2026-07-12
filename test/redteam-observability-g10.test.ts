import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// G10: observability stamping.
//
// Asserts that:
//   1. Every traced strategy generation (bull, bear, red-team) carries metadata.promptVersion
//      sourced from the single STRATEGY_PROMPT_VERSION constant.
//   2. The bear generation stamps the Bear-veto decision (bearVeto / bearVetoCount in its output).
//   3. A rationale diversity-collapse emits a stamped recordDecisionObservation.
//
// We mock ../src/lib/observability so `withLlmGeneration` still runs its callback (no behavior
// change) but records every options object, and `recordDecisionObservation` is a spy. This proves
// the stamping without needing a live Langfuse endpoint (the real helpers are hard no-ops when
// Langfuse is unconfigured, so nothing is emitted in Test mode otherwise).

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
  delete process.env.OPENAI_API_KEY;
});

// Two near-identical proposals so the post-gate rationale-diversity check collapses. Both are
// high-conviction so the Red Team debate runs.
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

function makeFetchStub(bearReturnsFewer: boolean) {
  const bullProposals = [COLLAPSED_PROPOSAL("AAPL"), COLLAPSED_PROPOSAL("MSFT")];
  // If the Bear vetoes one, it returns a single survivor → bearVetoCount > 0.
  const bearProposals = bearReturnsFewer ? [COLLAPSED_PROPOSAL("AAPL")] : bullProposals;
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      const body = init?.body ? String(init.body) : "{}";
      if (body.includes("Red Team Risk Agent")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rejected: false, reason: "ok" }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // First strategy call is Bull, second is Bear. Track by count of prior strategy calls.
      strategyCallCount += 1;
      const proposals = strategyCallCount === 1 ? bullProposals : bearProposals;
      return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals }) }), { status: 200, headers: { "content-type": "application/json" } });
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
    return new Response("not found", { status: 404 });
  };
}

let strategyCallCount = 0;

async function seed() {
  const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openai", "test-openai-key", "t");
  const id = randomUUID();
  upsertConnectedAccount({ id, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test", isActive: true });
  setActiveConnectedAccount(id);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL", "MSFT"],
    strategyAuthority: "decide"
  });
}

describe("observability stamping (G10)", () => {
  it("stamps promptVersion on bull/bear/red-team generations, a Bear-veto in bear output, and a diversity-collapse observation", async () => {
    strategyCallCount = 0;
    process.env.OPENAI_API_KEY = "test-openai-key";
    // Bear keeps BOTH near-identical proposals so ≥2 survive to the post-gate diversity check and it
    // collapses. The Bear-veto stamping is asserted directly on the output mapper below (a pure fn),
    // so it doesn't require the run to actually drop a proposal.
    vi.stubGlobal("fetch", makeFetchStub(false));

    await seed();
    const { runStrategyOnce, STRATEGY_PROMPT_VERSION } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // (1) The bull + bear generations carry the promptVersion constant.
    const bull = generationOptions.find((g) => g.name === "trading.strategy.bull");
    const bear = generationOptions.find((g) => g.name === "trading.strategy.bear");
    expect(bull?.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);
    expect(bear?.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);

    // The red-team debate generation was also traced AND stamped with the same promptVersion.
    const redTeam = generationOptions.find((g) => g.name === "trading.red-team.debate");
    expect(redTeam).toBeDefined();
    expect(redTeam?.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);

    // (2) Bear-veto decision point: the bear returned fewer survivors than it reviewed → the output
    //     mapper stamps bearVeto=true / bearVetoCount>0.
    const bearOut = bear?.output?.({ text: "{}", proposals: [COLLAPSED_PROPOSAL("AAPL")], fallbackToBull: false }) as
      | { bearVeto?: boolean; bearVetoCount?: number }
      | undefined;
    expect(bearOut?.bearVeto).toBe(true);
    expect(bearOut?.bearVetoCount).toBeGreaterThanOrEqual(1);

    // (3) The diversity-collapse observation was emitted with a stamped promptVersion + tag.
    const collapse = decisionObservations.find((o) => o.name === "trading.strategy.diversity-collapse");
    expect(collapse).toBeDefined();
    expect(collapse?.metadata?.promptVersion).toBe(STRATEGY_PROMPT_VERSION);
    expect(collapse?.tags).toContain("diversity-collapse");
  }, 30_000);
});

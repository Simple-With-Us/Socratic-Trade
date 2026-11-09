/**
 * Handoff 3.5 — strategy.ts wiring for the upcomingEconomicEvents prompt block
 * (modeled on test/regime-severity.test.ts's wiring group).
 *
 * Asserts the Bull userContent carries a compact `upcomingEconomicEvents` block next to
 * `currentMarketRegime` when the economic_events cache has events in the forward horizon,
 * and that the block is ENTIRELY ABSENT when there is no calendar data (never an empty
 * scaffold). No FMP key is set, so the daily ingest is key-gated off and the test is
 * deterministic — the cache is seeded directly via the db-economic-events CRUD.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

vi.mock("../src/lib/macro", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/macro")>();
  const stubMacro = {
    fedFundsRate: "5.25%",
    dgs10Treasury: "4.20%",
    cpiInflation: "3.10%",
    unemploymentRate: "3.90%",
    vix: "18.00",
    asOf: "2026-07-15"
  };
  return {
    ...actual,
    fetchMacroData: async () => stubMacro,
    fetchMacroDataWithLiveVix: async () => stubMacro
  };
});
vi.mock("../src/lib/market-signals", () => ({
  getMarketSignals: async () => undefined
}));

const PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 50,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Test proposal for economic-calendar prompt wiring.",
  tradeThesisTag: "Momentum",
  entryMarketRegime: "placeholder-overwritten-by-strategy",
  confidenceScore: 60
};

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-07-15",
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

function stubOpenAiAndNasdaq(openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }>): void {
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
}

async function seed(): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Econ Calendar Test", isActive: true });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "openai/gpt-4.1-mini",
    redTeamLlmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide"
  });
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-econ-prompt-${randomUUID()}.db`)}`;
  delete process.env.FMP_API_KEY; // key-gated ingest stays off; the cache is seeded directly
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

describe("strategy.ts upcomingEconomicEvents prompt wiring (handoff 3.5)", () => {
  it("cache has forward events: userContent carries a compact upcomingEconomicEvents block next to currentMarketRegime", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    stubOpenAiAndNasdaq(openAiBodies);
    await seed();

    // Seed the rolling cache with events inside the forward horizon (tomorrow + the day after).
    const { upsertEconomicEvents } = await import("../src/lib/db");
    const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    upsertEconomicEvents([
      { id: `${day(1)} 08:30:00|cpi (yoy)`, event: "CPI (YoY)", eventDate: `${day(1)} 08:30:00`, country: "US", impact: "High", estimate: 3.0, previous: 3.1 },
      { id: `${day(2)} 14:00:00|fomc interest rate decision`, event: "FOMC Interest Rate Decision", eventDate: `${day(2)} 14:00:00`, country: "US", impact: "High", estimate: null, previous: null }
    ]);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const bullBody = bullPromptBody(openAiBodies);
    const userContent = JSON.parse(bullBody.input!.find((item) => item.role === "user")?.content ?? "{}");
    expect(userContent.currentMarketRegime).toBeDefined();
    expect(userContent.upcomingEconomicEvents).toBeDefined();
    expect(userContent.upcomingEconomicEvents.note).toContain("HIGH-impact US economic events");
    const events = userContent.upcomingEconomicEvents.events as Array<{ event: string; date: string; impact?: string }>;
    expect(events.map((event) => event.event)).toEqual(["CPI (YoY)", "FOMC Interest Rate Decision"]);
    expect(events[0].date).toContain(day(1));
    expect(events[0].impact).toBe("High");
  }, 75_000);

  it("no calendar data: the upcomingEconomicEvents block is ENTIRELY absent — no empty scaffold", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    const openAiBodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    stubOpenAiAndNasdaq(openAiBodies);
    await seed();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const bullBody = bullPromptBody(openAiBodies);
    const userContent = JSON.parse(bullBody.input!.find((item) => item.role === "user")?.content ?? "{}");
    expect(userContent.currentMarketRegime).toBeDefined();
    expect("upcomingEconomicEvents" in userContent).toBe(false);
  }, 75_000);
});

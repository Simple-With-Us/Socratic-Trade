import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { enforceCandidateSetForOpenings, sanitizeProposals } from "../src/lib/strategy";
import type { TradeProposal } from "../src/lib/types";

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
  storeContexts: async () => ({ attempted: 0, indexed: 0 })
}));

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-candidate-boundary-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

function proposal(symbol: string, side: TradeProposal["side"]): TradeProposal {
  return {
    symbol,
    side,
    type: "market",
    dollarAmount: 100,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Focused candidate-boundary regression.",
    tradeThesisTag: "Momentum-Breakout",
    entryMarketRegime: "Neutral",
    confidenceScore: 75
  };
}

const TOP_CANDIDATES = [{ symbol: "AAPL" }];

describe("strict marketScan.topCandidates opening boundary", () => {
  it("drops policy-otherwise-allowed off-candidate buy and short openings", () => {
    const result = enforceCandidateSetForOpenings(
      [proposal("MSFT", "buy"), proposal("TSLA", "short")],
      TOP_CANDIDATES
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => [item.symbol, item.side])).toEqual([
      ["MSFT", "buy"],
      ["TSLA", "short"]
    ]);
  });

  it("matches candidate symbols after proposal normalization", () => {
    const normalized = sanitizeProposals([proposal(" aapl ", "buy")]);
    const result = enforceCandidateSetForOpenings(normalized, TOP_CANDIDATES);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.symbol).toBe("AAPL");
  });

  it("retains a legitimate candidate opening", () => {
    const result = enforceCandidateSetForOpenings([proposal("AAPL", "buy")], TOP_CANDIDATES);

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((item) => item.symbol)).toEqual(["AAPL"]);
  });

  it("retains sell and cover exits outside the current candidate set", () => {
    const result = enforceCandidateSetForOpenings(
      [proposal("MSFT", "sell"), proposal("TSLA", "cover")],
      TOP_CANDIDATES
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((item) => [item.symbol, item.side])).toEqual([
      ["MSFT", "sell"],
      ["TSLA", "cover"]
    ]);
  });

  it("audits and drops a policy-allowed off-candidate opening before Red review or sizing", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    let bullRequest: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" || url instanceof URL ? url.toString() : (url as Request).url;
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(JSON.stringify(body)).not.toContain("Red Team Risk Agent");
        bullRequest = body;
        return new Response(
          JSON.stringify({ output_text: JSON.stringify({ proposals: [proposal("MSFT", "buy")] }) }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href.includes("nasdaq.com")) {
        return new Response(
          JSON.stringify({
            data: {
              asof: "2026-07-13",
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
    });

    const { setActiveConnectedAccount, setPolicy, upsertConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Candidate Boundary Test",
      isActive: true
    });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      accountNumber: "TEST",
      llmModel: "openai/gpt-4.1-mini",
      redTeamLlmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      // MSFT is policy-allowed but absent from this exact scan result.
      additionalSymbols: ["AAPL", "MSFT"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    expect(result.status).toBe("completed");
    expect(result.proposals).toEqual([]);
    const rejection = listAudit(500).find((entry) => entry.kind === "proposal_rejected_off_candidate_opening");
    expect(rejection?.payload).toMatchObject({ runId: result.runId, symbol: "MSFT", side: "buy", candidates: ["AAPL"] });

    const schemaObj = (bullRequest as any)?.text?.format?.schema ?? (bullRequest as any)?.response_format?.json_schema?.schema;
    const itemSchema = schemaObj?.properties?.proposals?.items;
    expect(Object.keys(itemSchema?.properties ?? {}).sort()).toEqual([...(itemSchema?.required ?? [])].sort());
    const symbolSchema = schemaObj?.properties?.proposals?.items?.properties?.symbol;
    expect(symbolSchema?.enum).toEqual(["AAPL"]);
  }, 30_000);
});

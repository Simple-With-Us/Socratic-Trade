import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, MarketQuote, MarketScan } from "../src/lib/types";

// Audit of the merged G3 change (2026-09-29, board 687a5fb4, lane h3): the account-questionnaire
// hold used to clear ONLY when an opening order was accepted, yet the run loop refused every
// opening order while the hold was set, so the hold could never clear by itself.  These tests drive
// the real `runStrategyOnce` loop (same harness shape as final-size-red-autonomous.test.ts) to pin
// the half-open behaviour end to end: a fresh hold pauses entries, a stale one lets ONE probe
// through, an accepted probe clears it, a refused probe re-arms it.

const { debateProposal, reviewEquityOrder, placeEquityOrder } = vi.hoisted(() => ({
  debateProposal: vi.fn(),
  reviewEquityOrder: vi.fn(),
  placeEquityOrder: vi.fn()
}));

vi.mock("../src/lib/red-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/red-team")>();
  return { ...actual, debateProposal };
});

vi.mock("../src/lib/rationale-diversity", () => ({
  computeRationaleDiversity: (rationales: string[]) => ({
    count: rationales.length,
    meanPairwiseSimilarity: 0,
    maxPairwiseSimilarity: 0,
    collapsed: false,
    threshold: 0.85
  })
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

vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        { AAPL: { symbol: "AAPL", price: 10, bid: 9.99, ask: 10, provider: "test-scan" } },
        []
      )
  };
});

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const quotes: MarketQuote[] = [
        {
          symbol: "AAPL",
          price: 10,
          bid: 9.99,
          ask: 10,
          volume: 1_000_000,
          intradayChangePct: 0.5,
          positionMarketValue: 0,
          score: 80,
          provider: "test-scan",
          asOf
        }
      ];
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: quotes,
        sectorBySymbol: { AAPL: "Technology" },
        quotesBySymbol: { AAPL: quotes[0] },
        warnings: []
      };
    }
  };
});

const ACCOUNT = "RH-QUESTIONNAIRE-LOOP";
const HOUR_MS = 60 * 60_000;

function gateway(): BrokerGateway {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, label: "Questionnaire loop test", agenticAllowed: true }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 100,
      buyingPower: 100,
      equityMarketValue: 0,
      optionMarketValue: 0,
      cash: 100
    }),
    getEquityPositions: async () => [],
    getEquityOrders: async () => [],
    getEquityQuotes: async (_account, symbols) =>
      Object.fromEntries(symbols.map((symbol) => [symbol, { symbol, bid: 9.99, ask: 10, asOf: new Date().toISOString() }])),
    getEquityTradability: async (_account, symbols) =>
      Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
    reviewEquityOrder,
    placeEquityOrder,
    cancelEquityOrder: async () => ({ orderId: randomUUID(), refId: randomUUID(), state: "cancelled", raw: {} })
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => gateway() };
});

const QUESTIONNAIRE_REJECTION =
  'Robinhood place_equity_order response had no order id: {"text":"API error 400: {\\"non_field_errors\\":[\\"We\'re required to have you answer some questions about your account.\\"]}"}';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-questionnaire-loop-${randomUUID()}.db`)}`;
  debateProposal.mockReset();
  reviewEquityOrder.mockReset();
  placeEquityOrder.mockReset();
  debateProposal.mockResolvedValue({
    verdict: "approve",
    rejected: false,
    available: true,
    reason: "Approved.",
    model: "gpt-5.6-terra"
  });
  reviewEquityOrder.mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
    estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
    alerts: [],
    raw: {}
  }));
});

function stubBuyProposal(dollarAmount: number = 2): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            proposals: [
              {
                symbol: "AAPL",
                side: "buy",
                type: "market",
                dollarAmount,
                timeInForce: "gfd",
                marketHours: "regular_hours",
                rationale: "Small-account value setup.",
                tradeThesisTag: "Value-Quality",
                entryMarketRegime: "Neutral (Normal Volatility)",
                confidenceScore: 75
              }
            ]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

async function configureAutonomousAccount(userId: string): Promise<void> {
  const { setPolicy, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "questionnaire-loop-account",
    userId,
    broker: "robinhood",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "Questionnaire loop account",
    isActive: true
  });
  upsertUserApiKey(userId, "openrouter", "test-openai-key", "test fixture");
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "questionnaire-loop-account",
      activeBroker: "robinhood",
      systemState: "active",
      strategyAuthority: "decide",
      llmModel: "openai/gpt-4.1-mini",
      redTeamLlmModel: "gpt-5.6-terra",
      includedIndices: [],
      additionalSymbols: ["AAPL"]
    },
    userId
  );
}

describe("account-questionnaire hold in the autonomous run loop", () => {
  it("pauses new entries while the broker's refusal is recent, without touching the broker", async () => {
    placeEquityOrder.mockResolvedValue({ orderId: randomUUID(), refId: randomUUID(), state: "filled", raw: {} });
    stubBuyProposal();
    const userId = `questionnaire-loop-fresh-${randomUUID()}`;
    await configureAutonomousAccount(userId);
    const { markAccountActionRequired, getAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    markAccountActionRequired(userId, ACCOUNT, "Robinhood requires you to answer account questions.", Date.now() - HOUR_MS);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(listRecentProposals(ACCOUNT, 20, userId).find((row) => row.proposal.symbol === "AAPL")).toMatchObject({ status: "blocked" });
    expect(getAccountActionRequired(userId, ACCOUNT)).toBeDefined();
  }, 900_000);

  it("lets one probe entry through once the interval has elapsed, and an accepted probe CLEARS the hold", async () => {
    placeEquityOrder.mockResolvedValue({ orderId: randomUUID(), refId: randomUUID(), state: "filled", filledQuantity: 0.2, averagePrice: 10, raw: {} });
    stubBuyProposal();
    const userId = `questionnaire-loop-probe-ok-${randomUUID()}`;
    await configureAutonomousAccount(userId);
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, markAccountActionRequired, getAccountActionRequired } = await import(
      "../src/lib/broker-account-questionnaire"
    );
    markAccountActionRequired(
      userId,
      ACCOUNT,
      "Robinhood requires you to answer account questions.",
      Date.now() - ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS - HOUR_MS
    );

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    // The deadlock this audit found: on the merged code this call count was 0 forever.
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(listRecentProposals(ACCOUNT, 20, userId).find((row) => row.proposal.symbol === "AAPL")?.status).not.toBe("blocked");
    expect(getAccountActionRequired(userId, ACCOUNT)).toBeUndefined();
    expect(listAudit(100, userId).some((event) => event.kind === "account_action_required_probe")).toBe(true);
  }, 900_000);

  it("a probe the broker refuses again re-arms the hold for a full interval", async () => {
    placeEquityOrder.mockRejectedValue(new Error(QUESTIONNAIRE_REJECTION));
    stubBuyProposal();
    const userId = `questionnaire-loop-probe-refused-${randomUUID()}`;
    await configureAutonomousAccount(userId);
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, evaluateAccountActionRequiredGate, getAccountActionRequired, markAccountActionRequired } =
      await import("../src/lib/broker-account-questionnaire");
    const firstSeen = Date.now() - ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS - HOUR_MS;
    markAccountActionRequired(userId, ACCOUNT, "Robinhood requires you to answer account questions.", firstSeen);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(listRecentProposals(ACCOUNT, 20, userId).find((row) => row.proposal.symbol === "AAPL")).toMatchObject({ status: "blocked" });
    const state = getAccountActionRequired(userId, ACCOUNT);
    expect(state).toBeDefined();
    // Still held, the ORIGINAL first-seen time is kept, and the retry interval restarted from now.
    expect(state?.since).toBe(new Date(firstSeen).toISOString());
    expect(evaluateAccountActionRequiredGate(userId, ACCOUNT, Date.now()).kind).toBe("hold");
  }, 900_000);
});

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

const { debateProposal, reviewEquityOrder, placeEquityOrder, marketState } = vi.hoisted(() => ({
  debateProposal: vi.fn(),
  reviewEquityOrder: vi.fn(),
  placeEquityOrder: vi.fn(),
  marketState: { symbols: ["AAPL"] as string[] }
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
      const quotes: MarketQuote[] = marketState.symbols.map((symbol) => ({
        symbol,
        price: symbol === "AAPL" ? 10 : 1,
        bid: symbol === "AAPL" ? 9.99 : 1,
        ask: symbol === "AAPL" ? 10 : 1,
        volume: 1_000_000,
        intradayChangePct: 0.5,
        positionMarketValue: 0,
        score: 80,
        provider: "test-scan",
        asOf
      }));
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: quotes.length,
        returnedQuotes: quotes.length,
        topCandidates: quotes,
        sectorBySymbol: Object.fromEntries(quotes.map((quote) => [quote.symbol, "Technology"])),
        quotesBySymbol: Object.fromEntries(quotes.map((quote) => [quote.symbol, quote])),
        warnings: []
      };
    }
  };
});

const ACCOUNT = "RH-QUESTIONNAIRE-LOOP";
const HOUR_MS = 60 * 60_000;

const accountState: {
  buyingPower: number;
  cash: number;
  positions: Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>;
} = { buyingPower: 100, cash: 100, positions: [] };

function gateway(): BrokerGateway {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, label: "Questionnaire loop test", agenticAllowed: true }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 100,
      buyingPower: accountState.buyingPower,
      equityMarketValue: 0,
      optionMarketValue: 0,
      cash: accountState.cash
    }),
    getEquityPositions: async () => accountState.positions,
    getEquityOrders: async () => [],
    getEquityQuotes: async (_account, symbols) =>
      Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          { symbol, bid: symbol === "AAPL" ? 9.99 : 1, ask: symbol === "AAPL" ? 10 : 1, asOf: new Date().toISOString() }
        ])
      ),
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
  accountState.buyingPower = 100;
  accountState.cash = 100;
  accountState.positions = [];
  marketState.symbols = ["AAPL"];
  debateProposal.mockResolvedValue({
    verdict: "approve",
    rejected: false,
    available: true,
    reason: "Approved.",
    model: "gpt-5.6-terra"
  });
  reviewEquityOrder.mockImplementation(async (input: { symbol: string; dollarAmount?: number; quantity?: number }) => ({
    estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * (input.symbol === "AAPL" ? 10 : 1),
    alerts: [],
    raw: {}
  }));
});

function stubBuyProposals(buys: Array<{ symbol: string; dollarAmount: number }>): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            proposals: buys.map((buy) => ({
              symbol: buy.symbol,
              side: "buy",
              type: "market",
              dollarAmount: buy.dollarAmount,
              timeInForce: "gfd",
              marketHours: "regular_hours",
              rationale: "Small-account value setup.",
              tradeThesisTag: "Value-Quality",
              entryMarketRegime: "Neutral (Normal Volatility)",
              confidenceScore: 75
            }))
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function stubBuyProposal(dollarAmount: number = 2): void {
  stubBuyProposals([{ symbol: "AAPL", dollarAmount }]);
}

async function configureAutonomousAccount(
  userId: string,
  overrides: { sellToFundBuy?: "off" | "suggest" | "propose" | "automated"; strategyAuthority?: "decide" | "propose" } = {}
): Promise<void> {
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
      strategyAuthority: overrides.strategyAuthority ?? "decide",
      llmModel: "openai/gpt-4.1-mini",
      redTeamLlmModel: "gpt-5.6-terra",
      includedIndices: [],
      additionalSymbols: marketState.symbols,
      ...(overrides.sellToFundBuy ? { sellToFundBuy: overrides.sellToFundBuy } : {})
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

// Review round on the h3 audit (2026-09-30, board 687a5fb4): sell-to-fund used to plan funding sells
// for buys that the account hold would then block, and a manual "Run once" was refused by the same
// hold even though it is propose-only and never touches the broker.
describe("account-questionnaire hold versus sell-to-fund and manual runs", () => {
  const BELOW_MINIMUM_REJECTION =
    'Robinhood place_equity_order response had no order id: {"text":"API error 400: {\\"non_field_errors\\":[\\"Fractional orders must be at least $1.\\"]}"}';

  // Mirrors the funding scenario in final-size-red-autonomous.test.ts: buying power $2 lets each buy
  // fit on its own (openingRiskCapacity clamps a buy to buying power), so only the CUMULATIVE $3 of
  // AAPL $2 + GOOG $1 leaves a $1 shortfall that one MSFT share covers.
  function seedFundingScenario(): void {
    accountState.buyingPower = 2;
    accountState.cash = 100;
    accountState.positions = [{ symbol: "MSFT", quantity: 10, averageCost: 1, marketValue: 10 }];
    marketState.symbols = ["AAPL", "GOOG"];
    stubBuyProposals([
      { symbol: "AAPL", dollarAmount: 2 },
      { symbol: "GOOG", dollarAmount: 1 }
    ]);
  }

  function acceptEverything(): void {
    placeEquityOrder.mockImplementation(async (input: { quantity?: number }) => ({
      orderId: randomUUID(),
      refId: randomUUID(),
      state: "filled",
      filledQuantity: input.quantity,
      averagePrice: 1,
      raw: {}
    }));
  }

  it("control: with no hold, automated sell-to-fund still places its funding sell", async () => {
    seedFundingScenario();
    acceptEverything();
    const userId = `questionnaire-fund-control-${randomUUID()}`;
    await configureAutonomousAccount(userId, { sellToFundBuy: "automated" });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce(userId);

    expect(result.status, result.summary).toBe("completed");
    expect(placeEquityOrder.mock.calls.map((call) => call[0])).toContainEqual(
      expect.objectContaining({ symbol: "MSFT", side: "sell", quantity: 1 })
    );
  }, 300_000);

  it("does not sell holdings to fund buys that the fresh account hold will block", async () => {
    seedFundingScenario();
    acceptEverything();
    const userId = `questionnaire-fund-hold-${randomUUID()}`;
    await configureAutonomousAccount(userId, { sellToFundBuy: "automated" });
    const { markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    markAccountActionRequired(userId, ACCOUNT, "Robinhood requires you to answer account questions.", Date.now() - 2 * HOUR_MS);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status, result.summary).toBe("completed");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    const proposals = listRecentProposals(ACCOUNT, 20, userId);
    expect(proposals.some((row) => row.proposal.tradeThesisTag === "Sell-to-Fund")).toBe(false);
    expect(listAudit(100, userId).some((event) => event.kind === "sell_to_fund_plan")).toBe(false);
    expect(proposals.find((row) => row.proposal.symbol === "AAPL")).toMatchObject({ status: "blocked" });
  }, 300_000);

  it("in the probe state funds only the first opening, not every buy the run wants", async () => {
    seedFundingScenario();
    acceptEverything();
    const userId = `questionnaire-fund-probe-${randomUUID()}`;
    await configureAutonomousAccount(userId, { sellToFundBuy: "automated" });
    const { ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS, markAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    markAccountActionRequired(
      userId,
      ACCOUNT,
      "Robinhood requires you to answer account questions.",
      Date.now() - ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS - HOUR_MS
    );

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status, result.summary).toBe("completed");
    // The first opening (AAPL $2) fits buying power on its own, so the single probe needs no funding.
    // Funding for BOTH openings (the $1 shortfall) would sell an MSFT share for a buy the hold may
    // still block.  On the unfixed code the plan exists and the MSFT sale was placed.
    expect(listAudit(100, userId).some((event) => event.kind === "sell_to_fund_plan")).toBe(false);
    expect(placeEquityOrder.mock.calls.map((call) => (call[0] as { symbol: string }).symbol)).not.toContain("MSFT");
    expect(placeEquityOrder.mock.calls.map((call) => (call[0] as { symbol: string }).symbol)).toContain("AAPL");
  }, 300_000);

  it("a manual Run once is not blocked by the hold: the card goes through as the human-approval probe", async () => {
    acceptEverything();
    stubBuyProposal(2);
    const userId = `questionnaire-manual-${randomUUID()}`;
    await configureAutonomousAccount(userId);
    const { markAccountActionRequired, getAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    markAccountActionRequired(userId, ACCOUNT, "Robinhood requires you to answer account questions.", Date.now() - HOUR_MS);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId, { manual: true });

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(listRecentProposals(ACCOUNT, 20, userId).find((row) => row.proposal.symbol === "AAPL")).toMatchObject({ status: "proposed" });
    // The hold itself is untouched: only an accepted order or the retry interval clears it.
    expect(getAccountActionRequired(userId, ACCOUNT)).toBeDefined();
  }, 900_000);

  it("books a placement-time sub-minimum refusal as a deterministic blocked row, not an uncertain placing loop", async () => {
    placeEquityOrder.mockRejectedValue(new Error(BELOW_MINIMUM_REJECTION));
    stubBuyProposal(2);
    const userId = `questionnaire-below-min-${randomUUID()}`;
    await configureAutonomousAccount(userId);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");
    const { getAccountActionRequired } = await import("../src/lib/broker-account-questionnaire");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    const row = listRecentProposals(ACCOUNT, 20, userId).find((entry) => entry.proposal.symbol === "AAPL");
    expect(row).toMatchObject({ status: "blocked" });
    const skipped = listAudit(100, userId).find((event) => event.kind === "order_skipped_broker_minimum");
    expect(skipped).toBeDefined();
    expect(listAudit(100, userId).some((event) => event.kind === "order_placement_uncertain")).toBe(false);
    // A per-order sizing refusal is not an account-level hold.
    expect(getAccountActionRequired(userId, ACCOUNT)).toBeUndefined();
  }, 900_000);
});

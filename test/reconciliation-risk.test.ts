import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { reconcilePendingFills, generateProactiveRiskProposals, planTakeProfitTrims, takeProfitTrimQuantity, redTeamConvictionThresholdForPolicy, redTeamDebateTrigger, redTeamNotionalPctOfNavThresholdForPolicy, shouldRunRedTeamDebate } from "../src/lib/strategy";
import { insertFillEvent, listFillEvents } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway } from "../src/lib/types";
import type { EquityOrder, TradingPolicy } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Type-cast mock helper so we don't need to implement the full interface
function createMockGateway(overrides: Partial<BrokerGateway>): BrokerGateway {
  return overrides as BrokerGateway;
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-reconciliation-${randomUUID()}.db`)}`;
});

describe("reconcilePendingFills", () => {
  it("updates pending_reconciliation live fills when matched broker order is filled", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-123";
    insertFillEvent({
      id: fillId,
      proposalId: "p1",
      runId: "r1",
      accountNumber: "ACC123",
      source: "live",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 150,
      notional: 1500,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { test: true }
    });

    const mockGateway = createMockGateway({
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "AAPL",
          side: "buy",
          type: "market",
          state: "filled",
          filledQuantity: 10,
          averagePrice: 155,
          createdAt: new Date().toISOString(),
          updatedAt: "2026-06-15T12:00:00.000Z"
        } as EquityOrder
      ]
    }) as unknown as BrokerGateway;

    await reconcilePendingFills(mockGateway, "ACC123");

    const fills = listFillEvents("ACC123", "live");
    const matched = fills.find((f) => f.id === fillId);
    expect(matched).toBeDefined();
    expect(matched!.status).toBe("filled");
    expect(matched!.price).toBe(155);
    expect(matched!.notional).toBe(1550);
  });

  it("updates status to cancelled/rejected when broker order fails", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-456";
    insertFillEvent({
      id: fillId,
      proposalId: "p2",
      runId: "r1",
      accountNumber: "ACC123",
      source: "live",
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      price: 400,
      notional: 2000,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { test: true }
    });

    const mockGateway = {
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "MSFT",
          side: "buy",
          type: "market",
          state: "cancelled",
          createdAt: new Date().toISOString()
        } as EquityOrder
      ]
    } as unknown as BrokerGateway;

    await reconcilePendingFills(mockGateway, "ACC123");

    const fills = listFillEvents("ACC123", "live");
    const matched = fills.find((f) => f.id === fillId);
    expect(matched).toBeDefined();
    expect(matched!.status).toBe("cancelled");
  });

  it("recognizes a mixed-case broker state as terminal-declined (isRejectedOrCanceledState is case-insensitive)", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-mixed-case";
    insertFillEvent({
      id: fillId,
      proposalId: "p2b",
      runId: "r1",
      accountNumber: "ACC123",
      source: "live",
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      price: 400,
      notional: 2000,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { test: true }
    });

    const mockGateway = {
      getEquityOrders: async () => [
        { id: brokerOrderId, symbol: "MSFT", side: "buy", type: "market", state: "Rejected", createdAt: new Date().toISOString() } as EquityOrder
      ]
    } as unknown as BrokerGateway;

    await reconcilePendingFills(mockGateway, "ACC123");

    const matched = listFillEvents("ACC123", "live").find((f) => f.id === fillId);
    expect(matched!.status).toBe("Rejected");
  });

  it("records the executed portion of a partially_filled live order", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-partial-1";
    insertFillEvent({
      id: fillId, proposalId: "pp1", runId: "r1", accountNumber: "ACCPF",
      source: "live", symbol: "AAPL", side: "buy", quantity: 10, price: 150, notional: 1500,
      status: "pending_reconciliation", brokerOrderId, raw: { test: true }
    });
    const mockGateway = createMockGateway({
      getEquityOrders: async () => [
        { id: brokerOrderId, symbol: "AAPL", side: "buy", type: "market", state: "partially_filled", filledQuantity: 4, averagePrice: 151, createdAt: new Date().toISOString(), updatedAt: "2026-06-15T12:00:00.000Z" } as EquityOrder
      ]
    });
    await reconcilePendingFills(mockGateway, "ACCPF");
    const matched = listFillEvents("ACCPF", "live").find((f) => f.id === fillId);
    expect(matched!.status).toBe("filled");
    expect(matched!.quantity).toBe(4);
    expect(matched!.notional).toBeCloseTo(604); // 4 * 151
  });

  it("books the executed shares when an order is cancelled after a partial fill", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-partial-2";
    insertFillEvent({
      id: fillId, proposalId: "pp2", runId: "r1", accountNumber: "ACCPF",
      source: "live", symbol: "MSFT", side: "buy", quantity: 5, price: 400, notional: 2000,
      status: "pending_reconciliation", brokerOrderId, raw: { test: true }
    });
    const mockGateway = createMockGateway({
      getEquityOrders: async () => [
        { id: brokerOrderId, symbol: "MSFT", side: "buy", type: "market", state: "canceled", filledQuantity: 2, averagePrice: 401, createdAt: new Date().toISOString(), updatedAt: "2026-06-15T12:05:00.000Z" } as EquityOrder
      ]
    });
    await reconcilePendingFills(mockGateway, "ACCPF");
    const matched = listFillEvents("ACCPF", "live").find((f) => f.id === fillId);
    // The 2 executed shares are booked (status filled), not dropped as cancelled.
    expect(matched!.status).toBe("filled");
    expect(matched!.quantity).toBe(2);
    expect(matched!.notional).toBeCloseTo(802); // 2 * 401
  });

  it("reconciles broker-paper pending fills even after many older paper fills", async () => {
    const accountNumber = `APCA-PAPER-${randomUUID()}`;
    for (let i = 0; i < 510; i++) {
      insertFillEvent({
        accountNumber,
        source: "paper",
        executionMode: "broker/paper",
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        status: "filled",
        filledAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      });
    }
    const fillId = randomUUID();
    const brokerOrderId = "paper-broker-order-1";
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "paper",
      executionMode: "broker/paper",
      symbol: "TSLA",
      side: "buy",
      quantity: 2,
      price: 200,
      notional: 400,
      status: "pending_reconciliation",
      brokerOrderId,
      filledAt: "2026-06-15T12:00:00.000Z"
    });

    const mockGateway = createMockGateway({
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "TSLA",
          side: "buy",
          type: "market",
          state: "filled",
          filledQuantity: 2,
          averagePrice: 201,
          createdAt: new Date().toISOString(),
          updatedAt: "2026-06-15T12:05:00.000Z"
        } as EquityOrder
      ]
    });

    await reconcilePendingFills(mockGateway, accountNumber);

    const matched = listFillEvents(accountNumber, "paper", 600).find((f) => f.id === fillId);
    expect(matched).toBeDefined();
    expect(matched!.status).toBe("filled");
    expect(matched!.price).toBe(201);
    expect(matched!.notional).toBe(402);
    expect(matched!.executionMode).toBe("broker/paper");
  });
});

describe("generateProactiveRiskProposals", () => {
  it("proposes full-position sells when stop-loss triggers (take-profit is handled by planTakeProfitTrims)", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      riskRules: {
        stopLossPct: 8,
        takeProfitPct: 20
      }
    };

    const positions = [
      { symbol: "AAPL", quantity: 10, averageCost: 200, marketValue: 2000 }, // No breach
      { symbol: "MSFT", quantity: 5, averageCost: 400, marketValue: 1800 }, // Down 10% (breaches 8% stop-loss)
      { symbol: "NVDA", quantity: 8, averageCost: 100, marketValue: 1000 }  // Up 25% (take-profit → NOT here anymore)
    ];

    const currentPrices = {
      AAPL: 200,
      MSFT: 360,
      NVDA: 125
    };

    const proposals = generateProactiveRiskProposals(positions, currentPrices, policy);

    // Only the stop-loss exit; the take-profit name is no longer emitted by this generator.
    expect(proposals).toHaveLength(1);
    const msft = proposals.find((p) => p.symbol === "MSFT");
    expect(msft).toBeDefined();
    expect(msft!.side).toBe("sell");
    expect(msft!.quantity).toBe(5);
    expect(msft!.rationale).toContain("stop-loss");
    expect(proposals.find((p) => p.symbol === "NVDA")).toBeUndefined();
  });

  describe("planTakeProfitTrims", () => {
    const positions = [{ symbol: "NVDA", quantity: 8, averageCost: 100, marketValue: 1000 }]; // +25% @ 125
    const prices = { NVDA: 125 };

    it("trims a configurable fraction at the target and lets the rest ride", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      const plan = planTakeProfitTrims(positions, prices, policy);
      expect(plan.proposals).toHaveLength(1);
      expect(plan.proposals[0]).toMatchObject({ symbol: "NVDA", side: "sell", quantity: 4 }); // 50% of 8
      expect(plan.proposals[0].rationale).toContain("take-profit");
      expect(plan.advancedBands).toEqual([{ symbol: "NVDA", band: 1 }]); // floor(25/20) = 1
    });

    it("full-exits when trim pct is undefined (back-compat) or >=100", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20 } }; // undefined trim → 100
      expect(planTakeProfitTrims(positions, prices, policy).proposals[0].quantity).toBe(8);
    });

    it("carries the band + cost basis on the proposal (committed on fill, not at plan time)", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      const plan = planTakeProfitTrims(positions, prices, policy);
      expect(plan.proposals[0]).toMatchObject({ takeProfitBand: 1, takeProfitBasis: 100 });
    });

    it("does NOT re-trim the same band for the same lot (monotonic ratchet, cost-basis matched)", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      // Already trimmed band 1 at basis 100; at +25% (still band 1, same basis) → no new trim.
      const plan = planTakeProfitTrims(positions, prices, policy, { NVDA: { band: 1, avgCost: 100 } });
      expect(plan.proposals).toHaveLength(0);
      expect(plan.advancedBands).toHaveLength(0);
    });

    it("trims again only when a higher band is reached", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      // +45% = band 2 (floor(45/20)), prior band 1 same basis → trims.
      const plan = planTakeProfitTrims([{ symbol: "NVDA", quantity: 8, averageCost: 100, marketValue: 1160 }], { NVDA: 145 }, policy, { NVDA: { band: 1, avgCost: 100 } });
      expect(plan.proposals).toHaveLength(1);
      expect(plan.advancedBands).toEqual([{ symbol: "NVDA", band: 2 }]);
    });

    it("resets the ratchet when the cost basis differs (close + rebuy starts fresh)", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      // Stored band 1 belongs to an OLD lot (basis 90); the current lot's basis is 100 → treat as band 0 → trims band 1.
      const plan = planTakeProfitTrims(positions, prices, policy, { NVDA: { band: 1, avgCost: 90 } });
      expect(plan.proposals).toHaveLength(1);
      expect(plan.advancedBands).toEqual([{ symbol: "NVDA", band: 1 }]);
    });

    it("emits a COVER trim for a profitable short when shorting is enabled", () => {
      const policy: TradingPolicy = { ...DEFAULT_POLICY, shortSellingEnabled: true, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      // Short @100, price 75 → +25% profit.
      const plan = planTakeProfitTrims([{ symbol: "TSLA", quantity: -8, averageCost: 100, marketValue: -600 }], { TSLA: 75 }, policy);
      expect(plan.proposals[0]).toMatchObject({ symbol: "TSLA", side: "cover", quantity: 4 });
    });

    it("emits nothing below the target or when takeProfitPct is 0", () => {
      const below: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 20, takeProfitTrimPct: 50 } };
      expect(planTakeProfitTrims([{ symbol: "NVDA", quantity: 8, averageCost: 100, marketValue: 900 }], { NVDA: 112 }, below).proposals).toHaveLength(0);
      const off: TradingPolicy = { ...DEFAULT_POLICY, riskRules: { takeProfitPct: 0, takeProfitTrimPct: 50 } };
      expect(planTakeProfitTrims(positions, prices, off).proposals).toHaveLength(0);
    });
  });

  describe("takeProfitTrimQuantity", () => {
    it("floors WHOLE-share positions to whole shares (no forced fractional order)", () => {
      expect(takeProfitTrimQuantity(8, 50)).toBe(4);
      expect(takeProfitTrimQuantity(8, 100)).toBe(8);
      expect(takeProfitTrimQuantity(10, 25)).toBe(2); // floor(2.5) → 2 whole shares
      expect(takeProfitTrimQuantity(3, 50)).toBe(1); // floor(1.5) → 1, remainder 2
    });
    it("full-exits a whole-share position when no clean whole-share slice exists", () => {
      expect(takeProfitTrimQuantity(1, 50)).toBe(1); // floor(0.5)=0 → full exit
      expect(takeProfitTrimQuantity(2, 25)).toBe(2); // floor(0.5)=0 → full exit
    });
    it("keeps a fractional trim for an already-fractional position", () => {
      expect(takeProfitTrimQuantity(2.5, 50)).toBe(1.25); // fractional position → fractional trim is fine
    });
  });

  it("returns nothing if no positions breach any thresholds", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      riskRules: {
        stopLossPct: 8,
        takeProfitPct: 20
      }
    };

    const positions = [
      { symbol: "AAPL", quantity: 10, averageCost: 200, marketValue: 2000 }
    ];

    const currentPrices = {
      AAPL: 195 // down 2.5%
    };

    const proposals = generateProactiveRiskProposals(positions, currentPrices, policy);
    expect(proposals).toHaveLength(0);
  });

  it("emits a COVER (not a sell) to exit a breached short when short selling is enabled", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      shortSellingEnabled: true,
      riskRules: { stopLossPct: 8, takeProfitPct: 20, shortStopLossPct: 8 }
    };
    // Short entered @100, price rose to 110 → short is down 10%, breaching the 8% short stop.
    const positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -550 }];
    const proposals = generateProactiveRiskProposals(positions, { TSLA: 110 }, policy);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].side).toBe("cover");
    expect(proposals[0].quantity).toBe(5);
    expect(proposals[0].rationale).toContain("short stop-loss");
  });

  it("does not manage a short position when short selling is disabled", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      shortSellingEnabled: false,
      riskRules: { stopLossPct: 8, shortStopLossPct: 8 }
    };
    const positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -550 }];
    const proposals = generateProactiveRiskProposals(positions, { TSLA: 110 }, policy);
    expect(proposals).toHaveLength(0);
  });
});

describe("red-team conviction threshold", () => {
  const baseProposal = {
    symbol: "AAPL",
    side: "buy" as const,
    type: "market" as const,
    dollarAmount: 10,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    rationale: "test",
    tradeThesisTag: "test",
    entryMarketRegime: "Neutral (Normal Volatility)"
  };

  it("defaults to the existing 80 confidence threshold", () => {
    expect(redTeamConvictionThresholdForPolicy(DEFAULT_POLICY)).toBe(80);
    expect(shouldRunRedTeamDebate({ ...baseProposal, confidenceScore: 79 }, DEFAULT_POLICY)).toBe(false);
    expect(shouldRunRedTeamDebate({ ...baseProposal, confidenceScore: 80 }, DEFAULT_POLICY)).toBe(true);
  });

  it("uses policy tuning when a custom threshold is configured", () => {
    const policy = { ...DEFAULT_POLICY, tuning: { redTeamConvictionThreshold: 65 } };
    expect(redTeamConvictionThresholdForPolicy(policy)).toBe(65);
    expect(shouldRunRedTeamDebate({ ...baseProposal, confidenceScore: 64 }, policy)).toBe(false);
    expect(shouldRunRedTeamDebate({ ...baseProposal, confidenceScore: 65 }, policy)).toBe(true);
  });

  // Stakes-scaled dissent (composite review E/high/S): widen the debate trigger beyond
  // confidenceScore alone.
  describe("stakes-scaled dissent", () => {
    const lowConfidence = { ...baseProposal, confidenceScore: 10 };

    it("defaults the notional threshold to 15% of NAV", () => {
      expect(redTeamNotionalPctOfNavThresholdForPolicy(DEFAULT_POLICY)).toBe(15);
      expect(redTeamNotionalPctOfNavThresholdForPolicy({ ...DEFAULT_POLICY, tuning: { redTeamNotionalPctOfNavThreshold: 25 } })).toBe(25);
    });

    it("does NOT trigger the debate for a low-confidence, small-notional paper trade with no context", () => {
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY)).toBe(false);
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY, {})).toBe(false);
      expect(redTeamDebateTrigger(lowConfidence, DEFAULT_POLICY, {})).toBeUndefined();
    });

    it("triggers on large notional even at low confidence", () => {
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY, { notionalPctOfNav: 15 })).toBe(true);
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY, { notionalPctOfNav: 14.99 })).toBe(false);
      expect(redTeamDebateTrigger(lowConfidence, DEFAULT_POLICY, { notionalPctOfNav: 20 })).toBe("notional");
    });

    it("triggers on a LIVE opening regardless of confidence or notional", () => {
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY, { isLiveOpening: true })).toBe(true);
      expect(redTeamDebateTrigger(lowConfidence, DEFAULT_POLICY, { isLiveOpening: true })).toBe("live_opening");
    });

    it("triggers when the proposal itself requests an owner-preference override", () => {
      const overrideProposal = { ...lowConfidence, autonomyOverride: { requested: true, thesis: "panic discount" } };
      expect(shouldRunRedTeamDebate(overrideProposal, DEFAULT_POLICY, {})).toBe(true);
      expect(redTeamDebateTrigger(overrideProposal, DEFAULT_POLICY, {})).toBe("override_requested");
    });

    it("triggers on an escalation-regime entry (Risk-Off/Crisis/Inverted)", () => {
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY, { entryMarketRegime: "Risk-Off (High Volatility)" })).toBe(true);
      expect(redTeamDebateTrigger(lowConfidence, DEFAULT_POLICY, { entryMarketRegime: "Risk-Off (High Volatility)" })).toBe("escalation_regime");
      // A calm regime does not trigger on its own.
      expect(shouldRunRedTeamDebate(lowConfidence, DEFAULT_POLICY, { entryMarketRegime: "Neutral (Normal Volatility)" })).toBe(false);
    });

    it("reports the confidence trigger first when multiple conditions fire", () => {
      const highConfidence = { ...baseProposal, confidenceScore: 90 };
      expect(redTeamDebateTrigger(highConfidence, DEFAULT_POLICY, { notionalPctOfNav: 50, isLiveOpening: true })).toBe("confidence");
    });
  });
});

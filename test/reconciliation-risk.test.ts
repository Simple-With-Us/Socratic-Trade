import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateProactiveRiskProposals, planTakeProfitTrims, takeProfitTrimQuantity } from "../src/lib/strategy";
import {
  getProposal,
  getSocraticDecisionCase,
  getStopPlans,
  insertFillEvent,
  insertProposal,
  listFillEvents,
  recordStopPlan,
  upsertSocraticDecisionCase
} from "../src/lib/db";
import {
  isUnusableBrokerOrderId,
  listPendingBrokerReconciliationFills,
  markUnreconcilableUnusableBrokerOrderFills
} from "../src/lib/db-fills";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway } from "../src/lib/types";
import type { EquityOrder, TradingPolicy } from "../src/lib/types";
import { reconcilePendingFills } from "../src/lib/strategy-execution";
import { isRiskAddingOpening } from "../src/lib/strategy-risk";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
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
    const proposalId = randomUUID();
    const brokerOrderId = "broker-order-123";
    const proposal = {
      symbol: "AAPL",
      side: "buy" as const,
      type: "market" as const,
      quantity: 10,
      timeInForce: "gfd" as const,
      marketHours: "regular_hours" as const,
      rationale: "Delayed-fill lifecycle regression.",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral"
    };
    insertProposal({
      id: proposalId,
      runId: "r1",
      accountNumber: "ACC123",
      proposal,
      decision: { approved: true, reasons: [] },
      estimatedNotional: 1500,
      status: "placed",
      executionMode: "broker/live"
    });
    upsertSocraticDecisionCase({
      id: proposalId,
      proposalId,
      runId: "r1",
      accountNumber: "ACC123",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum-Breakout",
      rationale: proposal.rationale,
      action: "BUY AAPL 10 sh"
    });
    insertFillEvent({
      id: fillId,
      proposalId,
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
    expect(getProposal(proposalId)?.status).toBe("filled");
    expect(getSocraticDecisionCase(proposalId)).toMatchObject({ status: "filled", notional: 1550 });
  });

  it("commits a per-position stop plan once a pending_reconciliation opening fill is CONFIRMED filled (the plan couldn't commit at placement time — the order might still cancel/expire before ever opening the lot; Codex review, PR #1371)", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-stopplan-1";
    insertFillEvent({
      id: fillId,
      accountNumber: "ACC-STOPPLAN-1",
      source: "live",
      symbol: "NVDA",
      side: "buy",
      quantity: 4,
      price: 100,
      notional: 400,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: {
        proposal: {
          symbol: "NVDA", side: "buy", type: "market", quantity: 4,
          timeInForce: "gfd", marketHours: "regular_hours", rationale: "opening buy",
          tradeThesisTag: "Breakout", entryMarketRegime: "Bull",
          stopPlan: { style: "trailing", rationale: "scale into strength" }
        }
      }
    });

    expect(getStopPlans("ACC-STOPPLAN-1")).toEqual({}); // not yet committed — still pending_reconciliation

    const mockGateway = createMockGateway({
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "NVDA",
          side: "buy",
          type: "market",
          state: "filled",
          filledQuantity: 4,
          averagePrice: 100,
          createdAt: new Date().toISOString(),
          updatedAt: "2026-06-15T12:00:00.000Z"
        } as EquityOrder
      ]
    }) as unknown as BrokerGateway;

    await reconcilePendingFills(mockGateway, "ACC-STOPPLAN-1");

    expect(getStopPlans("ACC-STOPPLAN-1")).toEqual({
      NVDA: { style: "trailing", rationale: "scale into strength", avgCost: 100, side: "long" }
    });
  });

  it("an EXPLICIT 'default' plan CLEARS an existing persisted override once the reconciled fill confirms filled (Codex review, PR #1371)", async () => {
    recordStopPlan("ACC-STOPPLAN-2", "NVDA", "none", "initial thesis", 100);
    expect(getStopPlans("ACC-STOPPLAN-2").NVDA).toMatchObject({ style: "none" });

    const fillId = randomUUID();
    const brokerOrderId = "broker-order-stopplan-2";
    insertFillEvent({
      id: fillId,
      accountNumber: "ACC-STOPPLAN-2",
      source: "live",
      symbol: "NVDA",
      side: "buy",
      quantity: 2,
      price: 105,
      notional: 210,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: {
        proposal: {
          symbol: "NVDA", side: "buy", type: "market", quantity: 2,
          timeInForce: "gfd", marketHours: "regular_hours", rationale: "scale-in add",
          tradeThesisTag: "Breakout", entryMarketRegime: "Bull",
          stopPlan: { style: "default" } // explicit reset
        }
      }
    });

    const mockGateway = createMockGateway({
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "NVDA",
          side: "buy",
          type: "market",
          state: "filled",
          filledQuantity: 2,
          averagePrice: 105,
          createdAt: new Date().toISOString(),
          updatedAt: "2026-06-15T12:00:00.000Z"
        } as EquityOrder
      ]
    }) as unknown as BrokerGateway;

    await reconcilePendingFills(mockGateway, "ACC-STOPPLAN-2");

    expect(getStopPlans("ACC-STOPPLAN-2")).toEqual({});
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
    expect(matched!.status).toBe("partially_filled");
    expect(matched!.quantity).toBe(4);
    expect(matched!.notional).toBeCloseTo(604); // 4 * 151
  });

  it("books the executed shares when an order is cancelled after a partial fill", async () => {
    const fillId = randomUUID();
    const proposalId = randomUUID();
    const brokerOrderId = "broker-order-partial-2";
    const proposal = {
      symbol: "MSFT",
      side: "buy" as const,
      type: "market" as const,
      quantity: 5,
      timeInForce: "gfd" as const,
      marketHours: "regular_hours" as const,
      rationale: "terminal partial lifecycle",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral"
    };
    insertProposal({
      id: proposalId,
      runId: "r-terminal-partial",
      accountNumber: "ACCPF",
      proposal,
      decision: { approved: true, reasons: [] },
      estimatedNotional: 2000,
      status: "placed",
      executionMode: "broker/live"
    });
    upsertSocraticDecisionCase({
      id: proposalId,
      proposalId,
      runId: "r-terminal-partial",
      accountNumber: "ACCPF",
      symbol: "MSFT",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum-Breakout",
      rationale: proposal.rationale,
      action: "BUY MSFT 5 sh"
    });
    insertFillEvent({
      id: fillId, proposalId, runId: "r1", accountNumber: "ACCPF",
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
    expect(getProposal(proposalId)).toMatchObject({ status: "filled", estimatedNotional: 802 });
    expect(getSocraticDecisionCase(proposalId)).toMatchObject({ status: "filled", notional: 802 });
  });

  it("never reduces an already-booked partial fill when a stale smaller snapshot arrives", async () => {
    const accountNumber = `MONO-PARTIAL-${randomUUID()}`;
    const fillId = randomUUID();
    const brokerOrderId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 4,
      price: 151,
      notional: 604,
      status: "partially_filled",
      brokerOrderId
    });

    await reconcilePendingFills(createMockGateway({
      getEquityOrders: async () => [{
        id: brokerOrderId,
        symbol: "AAPL",
        side: "buy",
        type: "market",
        state: "partially_filled",
        filledQuantity: 2,
        averagePrice: 149,
        createdAt: new Date().toISOString()
      } as EquityOrder]
    }), accountNumber);

    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "partially_filled",
      quantity: 4,
      price: 151,
      notional: 604
    });
  });

  it("finalizes the known partial instead of rejecting it when a terminal snapshot regresses to zero", async () => {
    const accountNumber = `MONO-TERMINAL-${randomUUID()}`;
    const proposalId = randomUUID();
    const brokerOrderId = randomUUID();
    const proposal = {
      symbol: "MSFT",
      side: "buy" as const,
      type: "market" as const,
      quantity: 5,
      timeInForce: "gfd" as const,
      marketHours: "regular_hours" as const,
      rationale: "monotonic terminal snapshot",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral"
    };
    insertProposal({
      id: proposalId,
      runId: randomUUID(),
      accountNumber,
      proposal,
      decision: { approved: true, reasons: [] },
      estimatedNotional: 2000,
      status: "placed",
      executionMode: "broker/live"
    });
    upsertSocraticDecisionCase({
      id: proposalId,
      proposalId,
      accountNumber,
      symbol: "MSFT",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum-Breakout",
      rationale: proposal.rationale,
      action: "BUY MSFT 5 sh"
    });
    insertFillEvent({
      proposalId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "MSFT",
      side: "buy",
      quantity: 2,
      price: 401,
      notional: 802,
      status: "partially_filled",
      brokerOrderId
    });

    await reconcilePendingFills(createMockGateway({
      getEquityOrders: async () => [{
        id: brokerOrderId,
        symbol: "MSFT",
        side: "buy",
        type: "market",
        state: "canceled",
        filledQuantity: 0,
        createdAt: new Date().toISOString()
      } as EquityOrder]
    }), accountNumber);

    expect(listFillEvents(accountNumber, "live")[0]).toMatchObject({ status: "filled", quantity: 2, price: 401, notional: 802 });
    expect(getProposal(proposalId)).toMatchObject({ status: "filled", estimatedNotional: 802 });
    expect(getSocraticDecisionCase(proposalId)).toMatchObject({ status: "filled", notional: 802 });
  });

  it("keeps an expanded cumulative fill pending when the broker omits its realized price", async () => {
    const accountNumber = `MONO-UNPRICED-${randomUUID()}`;
    const fillId = randomUUID();
    const brokerOrderId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "NVDA",
      side: "buy",
      quantity: 2,
      price: 100,
      notional: 200,
      status: "partially_filled",
      brokerOrderId
    });

    await reconcilePendingFills(createMockGateway({
      getEquityOrders: async () => [{
        id: brokerOrderId,
        symbol: "NVDA",
        side: "buy",
        type: "market",
        state: "filled",
        filledQuantity: 4,
        createdAt: new Date().toISOString()
      } as EquityOrder]
    }), accountNumber);

    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "partially_filled",
      quantity: 2,
      price: 100,
      notional: 200
    });
  });

  it("preserves an unpriced pending quantity floor until an equal-or-larger priced snapshot arrives", async () => {
    const accountNumber = `MONO-PENDING-FLOOR-${randomUUID()}`;
    const fillId = randomUUID();
    const brokerOrderId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 4,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { execution: { filledQuantity: 4 } }
    });

    let snapshot: EquityOrder = {
      id: brokerOrderId,
      symbol: "AAPL",
      side: "buy",
      type: "market",
      state: "partially_filled",
      filledQuantity: 2,
      averagePrice: 149,
      createdAt: new Date().toISOString()
    };
    const gateway = createMockGateway({ getEquityOrders: async () => [snapshot] });
    await reconcilePendingFills(gateway, accountNumber);

    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "pending_reconciliation",
      quantity: 4,
      price: 0,
      notional: 0,
      raw: expect.objectContaining({ maxBrokerFilledQuantity: 4 })
    });

    snapshot = { ...snapshot, filledQuantity: 4, averagePrice: 151 };
    await reconcilePendingFills(gateway, accountNumber);
    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "partially_filled",
      quantity: 4,
      price: 151,
      notional: 604
    });
  });

  it("excludes unusable broker_order_id and unreconcilable fills from the pending reconcile list", () => {
    const accountNumber = `UNRECON-LIST-${randomUUID()}`;
    const goodId = randomUUID();
    const badUndefinedId = randomUUID();
    const badEmptyId = randomUUID();
    const alreadyUnreconcilableId = randomUUID();

    insertFillEvent({
      id: goodId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "pending_reconciliation",
      brokerOrderId: "real-broker-order-1"
    });
    insertFillEvent({
      id: badUndefinedId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "MSFT",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "pending_reconciliation",
      brokerOrderId: "undefined"
    });
    insertFillEvent({
      id: badEmptyId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "GOOG",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "pending_reconciliation",
      brokerOrderId: ""
    });
    insertFillEvent({
      id: alreadyUnreconcilableId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "TSLA",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "unreconcilable",
      brokerOrderId: "undefined"
    });

    expect(isUnusableBrokerOrderId("undefined")).toBe(true);
    expect(isUnusableBrokerOrderId("")).toBe(true);
    expect(isUnusableBrokerOrderId(null)).toBe(true);
    expect(isUnusableBrokerOrderId("real-broker-order-1")).toBe(false);

    const pending = listPendingBrokerReconciliationFills(accountNumber);
    expect(pending.map((f) => f.id)).toEqual([goodId]);
    expect(pending.some((f) => f.brokerOrderId === "undefined")).toBe(false);
    expect(pending.some((f) => f.status === "unreconcilable")).toBe(false);
  });

  it("flips pending fills with unusable broker_order_id to unreconcilable (forward guard + list exclusion)", async () => {
    const accountNumber = `UNRECON-FLIP-${randomUUID()}`;
    const badId = randomUUID();
    const goodId = randomUUID();
    const goodBrokerOrderId = `broker-${randomUUID()}`;

    insertFillEvent({
      id: badId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 10,
      notional: 10,
      status: "pending_reconciliation",
      brokerOrderId: "undefined"
    });
    insertFillEvent({
      id: goodId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "MSFT",
      side: "buy",
      quantity: 2,
      price: 50,
      notional: 100,
      status: "pending_reconciliation",
      brokerOrderId: goodBrokerOrderId
    });

    const getEquityOrders = vi.fn(async () => [
      {
        id: goodBrokerOrderId,
        symbol: "MSFT",
        side: "buy",
        type: "market",
        state: "filled",
        filledQuantity: 2,
        averagePrice: 51,
        createdAt: new Date().toISOString(),
        updatedAt: "2026-06-15T12:00:00.000Z"
      } as EquityOrder
    ]);
    await reconcilePendingFills(createMockGateway({ getEquityOrders }), accountNumber);

    const bad = listFillEvents(accountNumber, "live").find((f) => f.id === badId);
    const good = listFillEvents(accountNumber, "live").find((f) => f.id === goodId);
    expect(bad?.status).toBe("unreconcilable");
    expect(good?.status).toBe("filled");
    expect(good?.price).toBe(51);
    // Quarantined bad id never reaches the broker listing path as a match target.
    expect(listPendingBrokerReconciliationFills(accountNumber)).toHaveLength(0);

    // Idempotent second pass: mark helper finds nothing once flipped.
    expect(markUnreconcilableUnusableBrokerOrderFills(accountNumber)).toHaveLength(0);
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

  it("emits a COVER to protect an existing breached short even when short selling is disabled", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      shortSellingEnabled: false,
      riskRules: { stopLossPct: 8, shortStopLossPct: 8 }
    };
    const positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -550 }];
    const proposals = generateProactiveRiskProposals(positions, { TSLA: 110 }, policy);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].side).toBe("cover");
    expect(proposals[0].quantity).toBe(5);
    expect(proposals[0].rationale).toContain("short stop-loss");
  });
});

// The conviction/stakes-scaled debate gate was REMOVED 2026-07-07 (single-adversary consolidation
// O2): every risk-adding opening is reviewed. The only routing question left is §3.5's
// net-risk-direction gate, exercised here.
describe("isRiskAddingOpening (§3.5 net-risk-direction gate)", () => {
  const baseProposal = {
    symbol: "AAPL",
    side: "buy" as const,
    type: "market" as const,
    dollarAmount: 10,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    rationale: "test",
    tradeThesisTag: "test",
    entryMarketRegime: "Neutral (Normal Volatility)",
    confidenceScore: 50
  };
  const position = (symbol: string, quantity: number) => ({
    symbol,
    quantity,
    averageCost: 100,
    marketValue: quantity * 100
  }) as any;

  it("reviews a buy that OPENS a new position (no existing book)", () => {
    expect(isRiskAddingOpening(baseProposal, [])).toBe(true);
  });

  it("reviews a buy that ADDS to an existing long", () => {
    expect(isRiskAddingOpening(baseProposal, [position("AAPL", 10)])).toBe(true);
  });

  it("EXEMPTS a buy against an existing net short (it covers — risk-reducing)", () => {
    expect(isRiskAddingOpening(baseProposal, [position("AAPL", -10)])).toBe(false);
  });

  it("reviews a short that opens or adds to a short", () => {
    expect(isRiskAddingOpening({ ...baseProposal, side: "short" as const }, [])).toBe(true);
    expect(isRiskAddingOpening({ ...baseProposal, side: "short" as const }, [position("AAPL", -5)])).toBe(true);
  });

  it("EXEMPTS a short against an existing net long (it trims — risk-reducing)", () => {
    expect(isRiskAddingOpening({ ...baseProposal, side: "short" as const }, [position("AAPL", 10)])).toBe(false);
  });

  it("EXEMPTS every exit side (sell/cover) unconditionally", () => {
    expect(isRiskAddingOpening({ ...baseProposal, side: "sell" as const }, [position("AAPL", 10)])).toBe(false);
    expect(isRiskAddingOpening({ ...baseProposal, side: "cover" as const }, [position("AAPL", -10)])).toBe(false);
  });

  it("nets positions across rows of the same symbol (case/format-insensitive)", () => {
    expect(isRiskAddingOpening(baseProposal, [position("aapl", -5), position("AAPL", 2)])).toBe(false); // net -3 → buy covers
    expect(isRiskAddingOpening(baseProposal, [position("aapl", -5), position("AAPL", 7)])).toBe(true); // net +2 → buy adds
  });

  it("does not let another symbol's position change the classification", () => {
    expect(isRiskAddingOpening(baseProposal, [position("MSFT", -100)])).toBe(true);
  });
});

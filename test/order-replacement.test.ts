import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, ConnectedAccount, EquityOrder, EquityOrderInput } from "../src/lib/types";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-replacement-${randomUUID()}.db`)}`;
});

describe("market replacement for stale limit orders", () => {
  it("cancels a stale limit order, rechecks broker state, and submits only remaining shares as market", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const { listFillEvents } = await import("../src/lib/db");
    const original = order({ id: "limit-1", quantity: 10, filledQuantity: 2, state: "accepted" });
    const canceled = order({ id: "limit-1", quantity: 10, filledQuantity: 2, state: "canceled" });
    const gateway = gatewayMock({
      orders: [[original], [canceled]],
      execution: { orderId: "market-1", refId: "ref-1", state: "accepted", raw: { id: "market-1" } }
    });

    const result = await replaceStaleLimitOrderWithMarket({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orderId: "limit-1",
      cancelSettleMs: 0
    });

    expect(result).toMatchObject({
      status: "replaced",
      canceledOrderId: "limit-1",
      replacementOrderId: "market-1",
      remainingQuantity: 8,
      fillStatus: "pending_reconciliation"
    });
    expect(gateway.cancelEquityOrder).toHaveBeenCalledWith("APCA-PAPER", "limit-1");
    expect(gateway.reviewEquityOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 8
    }));
    expect(gateway.placeEquityOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 8,
      refId: expect.any(String)
    }));

    const fills = listFillEvents("APCA-PAPER", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      brokerOrderId: "market-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 8,
      status: "pending_reconciliation",
      executionMode: "broker/paper"
    });
  });

  it("requires typed confirmation before replacing a live Brokerage order", async () => {
    const { MarketReplaceConfirmationError, replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const gateway = gatewayMock({ orders: [[order({ id: "live-limit" })]] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: livePolicy(),
        activeAccount: account("live"),
        gateway,
        orderId: "live-limit",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({
      name: "MarketReplaceConfirmationError",
      expectedText: "REPLACE LIVE AAPL"
    });
    expect(MarketReplaceConfirmationError).toBeDefined();
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does not place a market order while cancel is still active at the broker", async () => {
    const { MarketReplacePreconditionError, replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const original = order({ id: "limit-1", state: "accepted" });
    const pendingCancel = order({ id: "limit-1", state: "pending_cancel" });
    const gateway = gatewayMock({ orders: [[original], [pendingCancel]] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account("paper"),
        gateway,
        orderId: "limit-1",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({
      name: "MarketReplacePreconditionError",
      message: "Cancel request is still pending at the broker. Wait for cancellation before placing the market replacement."
    });
    expect(MarketReplacePreconditionError).toBeDefined();
    expect(gateway.cancelEquityOrder).toHaveBeenCalledWith("APCA-PAPER", "limit-1");
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });
});

function paperPolicy() {
  return {
    ...DEFAULT_POLICY,
    activeBroker: "alpaca" as const,
    connectedAccountId: "acct-paper",
    accountNumber: "APCA-PAPER",
    staleLimitOrderMinutes: 15
  };
}

function livePolicy() {
  return {
    ...paperPolicy(),
    connectedAccountId: "acct-live",
    accountNumber: "APCA-LIVE"
  };
}

function account(environment: "paper" | "live"): ConnectedAccount {
  return {
    id: environment === "paper" ? "acct-paper" : "acct-live",
    userId: "local",
    broker: "alpaca",
    environment,
    accountNumber: environment === "paper" ? "APCA-PAPER" : "APCA-LIVE",
    label: environment === "paper" ? "Alpaca Paper" : "Alpaca Brokerage",
    isActive: true,
    capabilities: {
      equityTrading: true,
      shortSelling: false,
      optionsTrading: false,
      futuresTrading: false,
      cryptoTrading: false,
      marginEnabled: false,
      accountType: "brokerage"
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "limit-1",
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    state: "accepted",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function gatewayMock(input: {
  orders: EquityOrder[][];
  execution?: { orderId?: string; refId: string; state: string; filledQuantity?: number; averagePrice?: number; raw: unknown };
}): BrokerGateway {
  const orderResponses = [...input.orders];
  return {
    getAccounts: vi.fn(async () => []),
    getPortfolio: vi.fn(),
    getEquityPositions: vi.fn(async () => []),
    getEquityOrders: vi.fn(async () => orderResponses.shift() ?? input.orders.at(-1) ?? []),
    getEquityQuotes: vi.fn(async () => ({})),
    getEquityTradability: vi.fn(async () => ({})),
    reviewEquityOrder: vi.fn(async (orderInput: EquityOrderInput) => ({
      estimatedNotional: Math.abs((orderInput.quantity ?? 0) * 100),
      alerts: [],
      raw: { reviewed: true }
    })),
    placeEquityOrder: vi.fn(async () => (
      input.execution ?? { orderId: "market-1", refId: "ref-1", state: "accepted", raw: { id: "market-1" } }
    )),
    cancelEquityOrder: vi.fn(async (_accountNumber: string, orderId: string) => ({
      orderId,
      refId: "cancel-ref",
      state: "canceled",
      raw: { canceled: true }
    }))
  };
}

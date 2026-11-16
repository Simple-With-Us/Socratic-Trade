/**
 * Tests for native Alpaca bracket orders (take-profit + stop-loss legs).
 *
 * All Alpaca API calls are mocked — no real orders are ever placed.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture createOrder call arguments for assertion
let lastCreateOrderOpts: any = null;
// Controllable nested-order response for sendRequest("/orders/{id}", {nested:true}, null, "GET")
let mockNestedOrder: any = null;
// When set, sendRequest for an "/orders/" endpoint throws this instead of resolving mockNestedOrder.
let mockSendRequestError: any = null;
let cancelledOrderIds: string[] = [];

vi.mock("@alpacahq/alpaca-trade-api", () => {
  class MockAlpaca {
      async getAccount() {
        return { account_number: "MOCK_ACC", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "10000" };
      }
      async getPositions() { return []; }
      async getOrders() { return []; }
      async createOrder(opts: any) {
        lastCreateOrderOpts = opts;
        return { id: "bracket_order_1", status: "accepted", qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder(id: string) { cancelledOrderIds.push(id); }
      async sendRequest(endpoint: string, _query?: unknown, _body?: unknown, _method?: string) {
        if (endpoint.startsWith("/orders/")) {
          if (mockSendRequestError) throw mockSendRequestError;
          return mockNestedOrder;
        }
        throw new Error(`unexpected sendRequest endpoint in test: ${endpoint}`);
      }
  }
  return { Alpaca: MockAlpaca, default: MockAlpaca };
});

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  lastCreateOrderOpts = null;
  mockNestedOrder = null;
  mockSendRequestError = null;
  cancelledOrderIds = [];
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-brackets-${randomUUID()}.db`)}`;

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-bracket-test",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper Brackets"
  });
});

describe("Alpaca bracket order support", () => {
  it("sets order_class=bracket, take_profit, and stop_loss when both legs are provided", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 10,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 200,
      bracketStopLoss: 170,
      refId: "bracket-ref-1"
    });

    expect(lastCreateOrderOpts).not.toBeNull();
    expect(lastCreateOrderOpts.order_class).toBe("bracket");
    expect(lastCreateOrderOpts.take_profit).toEqual({ limit_price: 200 });
    expect(lastCreateOrderOpts.stop_loss).toEqual({ stop_price: 170 });
    // No limit_price on stop_loss when bracketStopLimit is absent
    expect(lastCreateOrderOpts.stop_loss.limit_price).toBeUndefined();
  });

  it("forces time_in_force to 'day' for bracket orders (even when 'gtc' would otherwise apply)", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "TSLA",
      side: "buy",
      type: "market",
      quantity: 5,
      timeInForce: "gtc", // This would normally map to "gtc" — bracket must force "day"
      marketHours: "regular_hours",
      bracketTakeProfit: 350,
      bracketStopLoss: 290,
      refId: "bracket-ref-2"
    });

    expect(lastCreateOrderOpts.time_in_force).toBe("day");
    expect(lastCreateOrderOpts.order_class).toBe("bracket");
  });

  it("uses stop-limit on the stop-loss leg when bracketStopLimit is provided", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "NVDA",
      side: "buy",
      type: "limit",
      quantity: 3,
      limitPrice: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 560,
      bracketStopLoss: 470,
      bracketStopLimit: 465, // Makes the stop-loss leg a stop-limit
      refId: "bracket-ref-3"
    });

    expect(lastCreateOrderOpts.order_class).toBe("bracket");
    expect(lastCreateOrderOpts.stop_loss).toEqual({ stop_price: 470, limit_price: 465 });
  });

  it("does NOT use notional for bracket orders — converts dollarAmount to qty", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AMZN",
      side: "buy",
      type: "limit",
      dollarAmount: 2000,
      limitPrice: 200, // estPrice = 200 → qty = floor(2000/200) = 10
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 230,
      bracketStopLoss: 185,
      refId: "bracket-ref-4"
    });

    // notional must NOT be present — Alpaca rejects notional bracket orders
    expect(lastCreateOrderOpts.notional).toBeUndefined();
    // qty must be present and derived from dollarAmount / limitPrice
    expect(lastCreateOrderOpts.qty).toBe(10);
    expect(lastCreateOrderOpts.order_class).toBe("bracket");
  });

  it("uses referencePrice for a bracketed dollar market order and never falls back to 1", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      referencePrice: 100,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 115,
      bracketStopLoss: 92,
      refId: "bracket-ref-reference-price"
    });

    expect(lastCreateOrderOpts.notional).toBeUndefined();
    expect(lastCreateOrderOpts.qty).toBe(5);
    expect(lastCreateOrderOpts.qty).not.toBe(500);
    expect(lastCreateOrderOpts.order_class).toBe("bracket");
  });

  it("fails closed for a bracketed dollar market order without a real price anchor", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await expect(gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 115,
      bracketStopLoss: 92,
      refId: "bracket-ref-missing-anchor"
    })).rejects.toThrow(/positive limitPrice or referencePrice/);
  });

  it("fails closed when a bracketed dollar order cannot buy one whole share", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await expect(gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "MSFT",
      side: "buy",
      type: "market",
      dollarAmount: 50,
      referencePrice: 100,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 115,
      bracketStopLoss: 92,
      refId: "bracket-ref-too-small"
    })).rejects.toThrow(/too small/);
  });

  it("does not set order_class when no bracket legs are provided", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "SPY",
      side: "buy",
      type: "market",
      quantity: 2,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "no-bracket-ref-5"
    });

    expect(lastCreateOrderOpts.order_class).toBeUndefined();
    expect(lastCreateOrderOpts.take_profit).toBeUndefined();
    expect(lastCreateOrderOpts.stop_loss).toBeUndefined();
  });

  it("sets order_class=bracket when only take_profit leg is provided", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "META",
      side: "buy",
      type: "market",
      quantity: 4,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      bracketTakeProfit: 600,
      // no bracketStopLoss
      refId: "bracket-tp-only-6"
    });

    expect(lastCreateOrderOpts.order_class).toBe("bracket");
    expect(lastCreateOrderOpts.take_profit).toEqual({ limit_price: 600 });
    expect(lastCreateOrderOpts.stop_loss).toBeUndefined();
    expect(lastCreateOrderOpts.time_in_force).toBe("day");
  });
});

describe("Alpaca native trailing stops (trailPercent)", () => {
  it("translates trailPercent to a trailing_stop order with trail_percent and NO stop/limit price", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      quantity: 10,
      stopPrice: 95, // a ratchet anchor meant for brokers without native trailing — must be dropped
      trailPercent: 5,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "trail-ref-1"
    });

    expect(lastCreateOrderOpts.type).toBe("trailing_stop");
    expect(lastCreateOrderOpts.trail_percent).toBe("5");
    expect(lastCreateOrderOpts.stop_price).toBeUndefined();
    expect(lastCreateOrderOpts.limit_price).toBeUndefined();
    expect(lastCreateOrderOpts.qty).toBe(10);
    expect(lastCreateOrderOpts.time_in_force).toBe("gtc");
    expect(lastCreateOrderOpts.client_order_id).toBe("trail-ref-1");
  });

  it("rejects a trailing stop combined with bracket legs (both would claim the same shares)", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await expect(gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 10,
      trailPercent: 5,
      bracketTakeProfit: 200,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "trail-ref-2"
    })).rejects.toThrow(/bracket/i);
    expect(lastCreateOrderOpts).toBeNull(); // never reached the broker
  });

  it("rejects a notional (no-quantity) trailing stop — Alpaca requires shares", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await expect(gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      dollarAmount: 500,
      trailPercent: 5,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "trail-ref-3"
    })).rejects.toThrow(/quantity/i);
    expect(lastCreateOrderOpts).toBeNull();
  });
});

describe("Alpaca cancelBracketSiblingLegs (bracket sibling-leg teardown)", () => {
  it("cancels only the still-open legs, skipping filled/canceled ones", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    mockNestedOrder = {
      id: "entry-order-1",
      status: "filled",
      legs: [
        { id: "tp-leg-1", status: "new" },
        { id: "sl-leg-1", status: "canceled" }
      ]
    };

    const result = await gateway.cancelBracketSiblingLegs!("MOCK_ACC", "entry-order-1");
    expect(result.cancelledOrderIds).toEqual(["tp-leg-1"]);
    expect(cancelledOrderIds).toEqual(["tp-leg-1"]);
  });

  it("cancels both legs when both are still open", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    mockNestedOrder = {
      id: "entry-order-2",
      status: "filled",
      legs: [
        { id: "tp-leg-2", status: "new" },
        { id: "sl-leg-2", status: "held" }
      ]
    };

    const result = await gateway.cancelBracketSiblingLegs!("MOCK_ACC", "entry-order-2");
    expect(result.cancelledOrderIds.sort()).toEqual(["sl-leg-2", "tp-leg-2"]);
  });

  it("returns no cancellations when the entry order has no legs (not a bracket)", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    mockNestedOrder = { id: "plain-order-1", status: "filled" };

    const result = await gateway.cancelBracketSiblingLegs!("MOCK_ACC", "plain-order-1");
    expect(result.cancelledOrderIds).toEqual([]);
    expect(cancelledOrderIds).toEqual([]);
  });

  it("fails closed (empty result, never throws) when the nested-order fetch itself fails", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    mockNestedOrder = undefined; // sendRequest resolves to undefined — simulates an unreachable/missing order
    const result = await gateway.cancelBracketSiblingLegs!("MOCK_ACC", "gone-order");
    expect(result.cancelledOrderIds).toEqual([]);
  });

  it("resolves as done (empty result) on a genuine 404 — the entry order is gone, nothing to tear down", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    mockSendRequestError = Object.assign(new Error("not found"), { response: { status: 404 } });
    const result = await gateway.cancelBracketSiblingLegs!("MOCK_ACC", "never-existed-order");
    expect(result.cancelledOrderIds).toEqual([]);
  });

  it("propagates a NON-404 lookup failure so the caller's bounded-retry sweep actually retries it", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    // A transient 5xx/rate-limit must NOT be swallowed into a silent "nothing to cancel" — the
    // teardown row would otherwise be dropped permanently on the very first hiccup instead of
    // retried (adversarial review of PR #1661, 2026-07-16).
    mockSendRequestError = Object.assign(new Error("rate limited"), { response: { status: 429 } });
    await expect(gateway.cancelBracketSiblingLegs!("MOCK_ACC", "entry-order-transient")).rejects.toThrow("rate limited");
  });
});

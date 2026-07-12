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

vi.mock("@alpacahq/alpaca-trade-api", () => {
  return {
    default: class MockAlpaca {
      async getAccount() {
        return { account_number: "MOCK_ACC", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "10000" };
      }
      async getPositions() { return []; }
      async getOrders() { return []; }
      async createOrder(opts: any) {
        lastCreateOrderOpts = opts;
        return { id: "bracket_order_1", status: "accepted", qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder() {}
    }
  };
});

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  lastCreateOrderOpts = null;
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

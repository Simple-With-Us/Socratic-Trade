import { describe, expect, it } from "vitest";
import {
  assertOptionOrderInput,
  cancelGatedOptionOrder,
  evaluateOptionOrderPolicy,
  formatOccSymbol,
  optionIntentToBrokerSide,
  optionNotionalUsd,
  parseOccSymbol,
  placeGatedOptionOrder,
  type OptionOrderInput
} from "../src/lib/option-orders";

const paperBuy: OptionOrderInput = {
  accountNumber: "PA",
  occSymbol: "AAPL240119C00150000",
  intent: "buy_to_open",
  quantity: 1,
  type: "limit",
  limitPrice: 2.5,
  refId: "opt-1"
};

describe("OCC symbology", () => {
  it("parses compact and spaced OCC symbols", () => {
    const compact = parseOccSymbol("AAPL240119C00150000");
    const spaced = parseOccSymbol("AAPL  240119C00150000");
    expect(compact?.underlyingSymbol).toBe("AAPL");
    expect(compact?.optionType).toBe("call");
    expect(compact?.strikePrice).toBe(150);
    expect(compact?.expirationDate).toBe("2024-01-19");
    expect(spaced?.occSymbol).toBe(compact?.occSymbol);
    expect(formatOccSymbol("AAPL", "2024-01-19", "call", 150)).toBe("AAPL  240119C00150000");
  });

  it("rejects junk", () => {
    expect(parseOccSymbol("AAPL")).toBeUndefined();
    expect(parseOccSymbol("")).toBeUndefined();
  });

  it("prices premium with the 100x multiplier", () => {
    expect(optionNotionalUsd(2.5, 2)).toBe(500);
    expect(optionIntentToBrokerSide("buy_to_open")).toBe("buy");
    expect(optionIntentToBrokerSide("sell_to_close")).toBe("sell");
  });
});

describe("option order policy", () => {
  it("blocks when the owner has not enabled options", () => {
    const d = evaluateOptionOrderPolicy({ optionsTradingEnabled: false, activeBroker: "alpaca" }, "broker/paper");
    expect(d.allowed).toBe(false);
  });

  it("allows Alpaca paper when options trading is on", () => {
    const d = evaluateOptionOrderPolicy({ optionsTradingEnabled: true, activeBroker: "alpaca" }, "broker/paper");
    expect(d).toEqual({ allowed: true, paperOnly: true, broker: "alpaca" });
  });

  it("blocks live until the live kill switch is on", () => {
    const blocked = evaluateOptionOrderPolicy(
      { optionsTradingEnabled: true, optionsLiveOrdersEnabled: false, activeBroker: "alpaca" },
      "broker/live"
    );
    expect(blocked.allowed).toBe(false);
    const live = evaluateOptionOrderPolicy(
      { optionsTradingEnabled: true, optionsLiveOrdersEnabled: true, activeBroker: "alpaca" },
      "broker/live"
    );
    expect(live).toEqual({ allowed: true, paperOnly: false, broker: "alpaca" });
  });

  it("never places on Robinhood", () => {
    const d = evaluateOptionOrderPolicy({ optionsTradingEnabled: true, activeBroker: "robinhood" }, "broker/paper");
    expect(d.allowed).toBe(false);
  });
});

describe("gated place/cancel", () => {
  it("places on paper through the gateway and refuses live by default", async () => {
    const placed: OptionOrderInput[] = [];
    const gw = {
      async placeOptionOrder(order: OptionOrderInput) {
        placed.push(order);
        return { orderId: "opt-ord-1", state: "accepted" };
      },
      async cancelOptionOrder() {
        return { orderId: "opt-ord-1", state: "cancel_requested" };
      }
    };
    const paper = await placeGatedOptionOrder({
      order: paperBuy,
      policy: { optionsTradingEnabled: true, activeBroker: "alpaca" },
      executionMode: "broker/paper",
      gateway: gw
    });
    expect(paper.ok).toBe(true);
    if (paper.ok) expect(paper.paperOnly).toBe(true);
    expect(placed).toHaveLength(1);

    const liveBlocked = await placeGatedOptionOrder({
      order: paperBuy,
      policy: { optionsTradingEnabled: true, activeBroker: "alpaca" },
      executionMode: "broker/live",
      gateway: gw
    });
    expect(liveBlocked.ok).toBe(false);
    expect(placed).toHaveLength(1);

    const cancelled = await cancelGatedOptionOrder({
      accountNumber: "PA",
      orderId: "opt-ord-1",
      policy: { optionsTradingEnabled: true, activeBroker: "alpaca" },
      executionMode: "broker/paper",
      gateway: gw
    });
    expect(cancelled.ok).toBe(true);
  });

  it("rejects a bad OCC input before touching the gateway", async () => {
    const result = await placeGatedOptionOrder({
      order: { ...paperBuy, occSymbol: "NOPE" },
      policy: { optionsTradingEnabled: true, activeBroker: "alpaca" },
      executionMode: "broker/paper",
      gateway: { async placeOptionOrder() { throw new Error("should not place"); } }
    });
    expect(result.ok).toBe(false);
    expect(assertOptionOrderInput({ ...paperBuy, quantity: 0 })).toMatch(/quantity/);
  });
});

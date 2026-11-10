/**
 * Unit tests for Options order policy and execution across brokers.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateOptionOrderPolicy,
  formatOccSymbol,
  parseOccSymbol,
  optionIntentToBrokerSide,
  optionNotionalUsd,
  assertOptionOrderInput
} from "../src/lib/option-orders";

describe("Option Orders Multi-Broker Suite", () => {
  it("parses and formats OCC option symbols accurately", () => {
    const raw = "AAPL260116C00200000";
    const parsed = parseOccSymbol(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.underlyingSymbol).toBe("AAPL");
    expect(parsed?.optionType).toBe("call");
    expect(parsed?.strikePrice).toBe(200);
    expect(parsed?.expirationDate).toBe("2026-01-16");

    const formatted = formatOccSymbol("AAPL", "2026-01-16", "call", 200);
    expect(formatted.replace(/\s+/g, "")).toBe(raw);
  });

  it("evaluates option order policy across supported brokers", () => {
    const paperPolicyAlpaca = {
      optionsTradingEnabled: true,
      optionsLiveOrdersEnabled: false,
      activeBroker: "alpaca"
    };
    const decAlpaca = evaluateOptionOrderPolicy(paperPolicyAlpaca, "broker/paper");
    expect(decAlpaca.allowed).toBe(true);

    const paperPolicyTradier = {
      optionsTradingEnabled: true,
      optionsLiveOrdersEnabled: false,
      activeBroker: "tradier"
    };
    const decTradier = evaluateOptionOrderPolicy(paperPolicyTradier, "broker/paper");
    expect(decTradier.allowed).toBe(true);

    const livePolicyTradier = {
      optionsTradingEnabled: true,
      optionsLiveOrdersEnabled: true,
      activeBroker: "tradier"
    };
    const decTradierLive = evaluateOptionOrderPolicy(livePolicyTradier, "broker/live");
    expect(decTradierLive.allowed).toBe(true);

    const livePolicyOff = {
      optionsTradingEnabled: true,
      optionsLiveOrdersEnabled: false,
      activeBroker: "tradier"
    };
    const decTradierBlocked = evaluateOptionOrderPolicy(livePolicyOff, "broker/live");
    expect(decTradierBlocked.allowed).toBe(false);
  });

  it("calculates option notional and intent sides correctly", () => {
    expect(optionNotionalUsd(2.5, 5)).toBe(1250);
    expect(optionIntentToBrokerSide("buy_to_open")).toBe("buy");
    expect(optionIntentToBrokerSide("sell_to_close")).toBe("sell");
    expect(optionIntentToBrokerSide("buy_to_close")).toBe("buy");
    expect(optionIntentToBrokerSide("sell_to_open")).toBe("sell");
  });
});

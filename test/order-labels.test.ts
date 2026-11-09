import { describe, expect, it } from "vitest";
import { brokerHeldExitBlockReason, evaluateBrokerHeldExitAvailability } from "../src/lib/broker-held-orders";
import { shortOrderLabel } from "../src/lib/order-labels";
import type { EquityOrder, EquityPosition, TradeProposal } from "../src/lib/types";

describe("shortOrderLabel", () => {
  it("uppercases and takes the first 8 chars of a broker UUID", () => {
    expect(shortOrderLabel("88f6af66-ed04-4f4f-b389-ade89f66306a")).toBe("88F6AF66");
  });

  it("strips non-alphanumeric separators before truncating", () => {
    expect(shortOrderLabel("ab-cd_ef.gh:ij")).toBe("ABCDEFGH");
  });

  it("returns the cleaned id as-is when shorter than 8 chars", () => {
    expect(shortOrderLabel("ab-1")).toBe("AB1");
  });

  it("returns a placeholder for an empty id", () => {
    expect(shortOrderLabel("")).toBe("?");
  });
});

describe("brokerHeldExitBlockReason short labels", () => {
  const longKo: EquityPosition[] = [
    { symbol: "KO", quantity: 29, averageCost: 82.02, marketValue: 2378.58 }
  ];

  function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
    return {
      symbol: "KO",
      side: "sell",
      type: "limit",
      quantity: 17,
      limitPrice: 81.9,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "risk exit",
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "Neutral (Normal Volatility)",
      ...overrides
    };
  }

  function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
    return {
      id: "88f6af66-ed04-4f4f-b389-ade89f66306a",
      symbol: "KO",
      side: "sell",
      type: "limit",
      state: "new",
      quantity: 29,
      filledQuantity: 0,
      createdAt: "2026-06-29T21:42:52.789Z",
      ...overrides
    };
  }

  it("renders the short label in the human-readable reason but keeps the full id in heldOrderIds", () => {
    const held = evaluateBrokerHeldExitAvailability(proposal(), longKo, [order()]);
    expect(held?.heldOrderIds).toEqual(["88f6af66-ed04-4f4f-b389-ade89f66306a"]);

    const reason = brokerHeldExitBlockReason(held!);
    expect(reason).toContain("Related open order(s): 88F6AF66");
    expect(reason).not.toContain("88f6af66-ed04-4f4f-b389-ade89f66306a");
  });
});

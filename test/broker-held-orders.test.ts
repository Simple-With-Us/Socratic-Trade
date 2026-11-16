import { describe, expect, it } from "vitest";
import {
  brokerHeldExitBlockReason,
  evaluateBrokerHeldExitAvailability,
  isActiveBrokerOrderState,
  isWorkingOrderState
} from "../src/lib/broker-held-orders";
import type { EquityOrder, EquityPosition, TradeProposal } from "../src/lib/types";

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
    id: "2a6ae4c7-c7d3-450c-a9c0-7a9a6a9099e5",
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

describe("broker-held exit availability", () => {
  it("blocks a sell when an existing open sell order already holds all shares", () => {
    const held = evaluateBrokerHeldExitAvailability(proposal(), longKo, [order()]);

    expect(held).toMatchObject({
      symbol: "KO",
      side: "sell",
      positionQuantity: 29,
      heldQuantity: 29,
      availableQuantity: 0,
      requestedQuantity: 17,
      heldOrderIds: ["2a6ae4c7-c7d3-450c-a9c0-7a9a6a9099e5"]
    });
    expect(brokerHeldExitBlockReason(held!)).toContain("Existing open sell order(s) already hold 29 of 29 KO shares");
  });

  it("allows a sell inside the remaining broker-available quantity", () => {
    const held = evaluateBrokerHeldExitAvailability(proposal({ quantity: 10 }), longKo, [
      order({ id: "existing-sell", quantity: 12 })
    ]);

    expect(held).toBeNull();
  });

  it("blocks only the excess above shares not already held for orders", () => {
    const held = evaluateBrokerHeldExitAvailability(proposal({ quantity: 18 }), longKo, [
      order({ id: "existing-sell", quantity: 12 })
    ]);

    expect(held).toMatchObject({
      heldQuantity: 12,
      availableQuantity: 17,
      requestedQuantity: 18
    });
  });

  it("subtracts only the unfilled remainder from a partially-filled open order", () => {
    const held = evaluateBrokerHeldExitAvailability(proposal({ quantity: 24 }), longKo, [
      order({ id: "partial-sell", state: "partially_filled", quantity: 20, filledQuantity: 5 })
    ]);

    expect(held).toMatchObject({
      heldQuantity: 15,
      availableQuantity: 14,
      requestedQuantity: 24,
      heldOrderIds: ["partial-sell"]
    });
  });

  it("ignores terminal broker order states", () => {
    const held = evaluateBrokerHeldExitAvailability(proposal(), longKo, [
      order({ state: "filled", quantity: 29 }),
      order({ state: "canceled", quantity: 29 }),
      order({ state: "rejected", quantity: 29 })
    ]);

    expect(held).toBeNull();
    expect(isActiveBrokerOrderState("new")).toBe(true);
    expect(isActiveBrokerOrderState("filled")).toBe(false);
  });

  it("applies the same held-quantity guard to short covers", () => {
    const shortPositions: EquityPosition[] = [
      { symbol: "KO", quantity: -50, averageCost: 80, marketValue: -4000 }
    ];
    const held = evaluateBrokerHeldExitAvailability(
      proposal({ side: "cover", quantity: 30 }),
      shortPositions,
      [order({ id: "cover-1", side: "buy", quantity: 25 })]
    );

    expect(held).toMatchObject({
      side: "cover",
      positionQuantity: 50,
      heldQuantity: 25,
      availableQuantity: 25,
      requestedQuantity: 30,
      heldOrderIds: ["cover-1"]
    });
  });
});

describe("isWorkingOrderState — open/pending list (excludes done_for_day)", () => {
  it("treats live Alpaca/RH states as working", () => {
    expect(isWorkingOrderState("new")).toBe(true);
    expect(isWorkingOrderState("held")).toBe(true);
    expect(isWorkingOrderState("partially_filled")).toBe(true);
    expect(isWorkingOrderState("confirmed")).toBe(true);
    expect(isWorkingOrderState("stopped")).toBe(true);
    expect(isWorkingOrderState("calculated")).toBe(true);
  });

  it("does NOT treat terminal done_for_day as working (history inflation guard)", () => {
    // Alpaca getEquityOrders pages status:"all"; day orders stay done_for_day forever.
    // Counting them as open produced false 300+ pending lists on paper accounts.
    expect(isWorkingOrderState("done_for_day")).toBe(false);
    expect(isWorkingOrderState("filled")).toBe(false);
    expect(isWorkingOrderState("canceled")).toBe(false);
    expect(isWorkingOrderState("expired")).toBe(false);
  });
});

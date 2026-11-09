import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";

// Broker minimum dollar-notional floor (Robinhood: $1). A sub-$1 advised/fallback size that rounds
// DOWN to $0 must still be raised to the floor when capacity covers it — otherwise the $0 order
// reaches the broker as a guaranteed reject. Regression guard for the Codex PR #1169 finding.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-brokermin-${randomUUID()}.db`)}`;
});

const PORTFOLIO: Portfolio = {
  accountNumber: "A",
  totalMarketValue: 1_000_000,
  buyingPower: 1_000_000,
  equityMarketValue: 0,
  optionMarketValue: 0,
  cash: 1_000_000
};

const NO_POSITIONS: EquityPosition[] = [];

function buyProposal(dollarAmount: number): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: "Momentum-Breakout",
    entryMarketRegime: "Tech-Bull",
    confidenceScore: 95,
    dollarAmount
  };
}

function robinhoodPolicy(): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: "RH",
    activeBroker: "robinhood",
    maxOrderNotional: 10_000,
    maxOrderPctOfNav: undefined
  };
}

describe("broker minimum dollar-notional sizing floor", () => {
  it("raises a sub-$1 advised size that rounded to $0 up to the Robinhood minimum", () => {
    const sized = applyDeterministicSizing(buyProposal(0.22), robinhoodPolicy(), PORTFOLIO, "paper", "local", NO_POSITIONS);

    // Without the pre-rounding guard this returns dollarAmount: 0 — the guaranteed-reject path.
    expect(sized.dollarAmount).toBe(1);
    expect(sized.rationale).toContain("Raised $0 to $1 to meet Robinhood's minimum dollar-based order size.");
  });

  it("raises a positive advised size between $0 and the floor up to the minimum", () => {
    const sized = applyDeterministicSizing(buyProposal(0.9), robinhoodPolicy(), PORTFOLIO, "paper", "local", NO_POSITIONS);

    expect(sized.dollarAmount).toBe(1);
    expect(sized.rationale).toContain("to meet Robinhood's minimum dollar-based order size.");
  });

  it("does not floor when the broker has no known minimum (Alpaca)", () => {
    const sized = applyDeterministicSizing(
      buyProposal(0.22),
      { ...robinhoodPolicy(), activeBroker: "alpaca" },
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    expect(sized.dollarAmount).toBe(0);
    expect(sized.rationale).not.toContain("minimum dollar-based order size");
  });

  it("does not raise to the floor when capacity cannot cover the minimum", () => {
    const sized = applyDeterministicSizing(
      buyProposal(0.22),
      { ...robinhoodPolicy(), maxOrderNotional: 0.5 },
      PORTFOLIO,
      "paper",
      "local",
      NO_POSITIONS
    );

    // Capacity < $1 → left too-small for the broker; policy review blocks it on per-order-cap grounds.
    expect(sized.dollarAmount).toBeLessThan(1);
    expect(sized.rationale).not.toContain("minimum dollar-based order size");
  });
});

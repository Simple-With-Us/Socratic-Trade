/**
 * runScopedGatePolicy — the run-scoped close_only clone behind
 * policy.triggerSettings.eventRunMode (2026-07-28).
 *
 * Money-path invariant (owner-directed): an event-triggered close_only run must execute with a
 * RUN-SCOPED policy clone — the stored policy object is never mutated, so the breaker setPolicy
 * paths and autoRevertOnCapBreach can never persist the override.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn((_userId: string) => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn((_userId: string) => new Map())
}));

import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import { runScopedGatePolicy } from "../src/lib/strategy";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000
};

const positions: EquityPosition[] = [
  { symbol: "AAPL", quantity: 5, averageCost: 200, marketValue: 1000, sector: "Technology" }
];

const activePolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["AAPL", "TSLA"],
  // Staleness gate off: these tests exercise the systemState gate only (see policy.test.ts).
  maxQuoteAgeSec: 0
} as TradingPolicy & { accountNumber: string };

const buyProposal: TradeProposal = {
  symbol: "TSLA",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test"
};

const sellProposal: TradeProposal = {
  ...buyProposal,
  symbol: "AAPL",
  side: "sell"
};

describe("runScopedGatePolicy (event-trigger close_only override)", () => {
  it("returns a close_only CLONE for an active policy — the input object is never mutated", () => {
    const gated = runScopedGatePolicy(activePolicy, "close_only");
    expect(gated).not.toBe(activePolicy);
    expect(gated.systemState).toBe("close_only");
    // The pristine object a breaker/autoRevert persistence path would write is untouched.
    expect(activePolicy.systemState).toBe("active");
  });

  it("returns the SAME object when there is no override (zero-cost, byte-identical path)", () => {
    expect(runScopedGatePolicy(activePolicy, undefined)).toBe(activePolicy);
  });

  it("never widens a stored non-active state (override applies to active only)", () => {
    const halted = { ...activePolicy, systemState: "halted" as const };
    expect(runScopedGatePolicy(halted, "close_only")).toBe(halted);
    const closeOnly = { ...activePolicy, systemState: "close_only" as const };
    expect(runScopedGatePolicy(closeOnly, "close_only")).toBe(closeOnly);
  });

  it("the clone rejects openings at the policy gate but lets exits through; the pristine policy still admits both", () => {
    const gated = runScopedGatePolicy(activePolicy, "close_only");
    const context = { portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 10 };

    const gatedBuy = evaluateTradeProposal(buyProposal, { ...context, policy: gated });
    expect(gatedBuy.approved).toBe(false);
    expect(gatedBuy.reasons).toContain("System is close-only. New entries are disabled.");

    const gatedSell = evaluateTradeProposal(sellProposal, { ...context, policy: gated });
    expect(gatedSell.reasons).not.toContain("System is close-only. New entries are disabled.");

    // Same proposals against the pristine (persistable) policy: no close-only block anywhere.
    const pristineBuy = evaluateTradeProposal(buyProposal, { ...context, policy: activePolicy });
    expect(pristineBuy.reasons).not.toContain("System is close-only. New entries are disabled.");
  });
});

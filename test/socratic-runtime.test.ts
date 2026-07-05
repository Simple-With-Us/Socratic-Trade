import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { applySocraticOverrideSizing, resolveSocraticOverride } from "../src/lib/socratic-runtime";
import type { PolicyDecision, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

const portfolio: Portfolio = {
  accountNumber: "acct",
  totalMarketValue: 10_000,
  buyingPower: 6_000,
  equityMarketValue: 4_000,
  optionMarketValue: 0,
  cash: 6_000
};

const policy: TradingPolicy = {
  ...DEFAULT_POLICY,
  accountNumber: "acct",
  strategyAuthority: "decide",
  socraticOverrideMode: "execute",
  socraticOverrideMaxPctOfNav: 100,
  maxOrderNotional: 500
};

const proposal: TradeProposal = {
  symbol: "NVDA",
  side: "buy",
  type: "market",
  dollarAmount: 900,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Flash-crash discount with evidence of forced selling, not thesis impairment.",
  tradeThesisTag: "Mean-Reversion",
  entryMarketRegime: "Crisis",
  confidenceScore: 88,
  autonomyOverride: {
    requested: true,
    thesis: "The selloff looks liquidity-driven; buying the discounted name is better than obeying the temporary preference cap.",
    preferenceConflicts: ["max order cap"],
    invalidation: "Credit stress widens further or the company-specific catalyst breaks.",
    cashDeploymentPct: 50
  }
};

describe("Socratic runtime override semantics", () => {
  it("turns owner-preference gate failures into an approved Socratic override", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: [
        "System is close-only. New entries are disabled.",
        "Order of $900.00 exceeds the maximum order limit of $500.00"
      ]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 900, decision });

    expect(result.applied).toBe(true);
    expect(result.decision.approved).toBe(true);
    expect(result.decision.socraticOverride?.conflicts).toHaveLength(2);
    expect(result.decision.socraticOverride?.thesis).toContain("liquidity-driven");
  });

  it("refuses hard broker/account/integrity failures", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["Order of $7000.00 exceeds available buying power $6000.00."]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 7_000, decision });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
    expect(result.hardReasons[0]).toContain("buying power");
  });

  it("raises override sizing against available cash while respecting the override cap", () => {
    const sized = applySocraticOverrideSizing(
      { ...proposal, dollarAmount: 300, autonomyOverride: { ...proposal.autonomyOverride!, cashDeploymentPct: 80 } },
      { ...policy, socraticOverrideMaxPctOfNav: 40 },
      portfolio
    );

    expect(sized.dollarAmount).toBe(4_000);
    expect(sized.quantity).toBeUndefined();
    expect(sized.rationale).toContain("Socratic override sizing");
  });

  it("applies the override for gates reclassified from hard to preference (short-stop-required, bracket-required)", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: [
        "Short proposals must carry a mandatory stop-loss (policy.riskRules.shortStopLossPct).",
        'Bracket orders require "bracket" in permittedOrderTypes or a stopLossPct risk rule.'
      ]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 900, decision });

    expect(result.applied).toBe(true);
    expect(result.decision.approved).toBe(true);
    expect(result.hardReasons).toHaveLength(0);
  });

  it("still refuses the regulatory margin-minimum (FINRA 26-10 / PDT successor) hard gate", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["margin_minimum: this LIVE margin account's equity $1000.00 is below the $2,000 margin minimum."]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 900, decision });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
    expect(result.hardReasons[0]).toContain("margin_minimum");
  });
});

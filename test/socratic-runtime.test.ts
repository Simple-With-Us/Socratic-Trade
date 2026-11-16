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

describe("Pre-veto reasons folded into the override path", () => {
  // A pre-veto reason is just another OVERRIDABLE decision reason once folded in (see the fold-in
  // block in strategy.ts). These tests exercise the fold-in shape directly against resolveSocraticOverride.
  it("applies the override for a red-team pre-veto with a requested thesis in execute mode", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["red_team_veto: The bull thesis ignores a deteriorating balance sheet and a fresh guidance cut."]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 900, decision });

    expect(result.applied).toBe(true);
    expect(result.decision.approved).toBe(true);
    expect(result.hardReasons).toHaveLength(0);
    expect(result.decision.socraticOverride?.conflicts).toContain(decision.reasons[0]);
  });

  it("applies the override for a deterministic-bear pre-veto in execute mode", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["deterministic_bear_veto: Crisis (Extreme Volatility) regime with below-median scan score (40.0 < median 70.0); risk-on entry too weak"]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 900, decision });

    expect(result.applied).toBe(true);
    expect(result.decision.approved).toBe(true);
    expect(result.conflicts).toContain(decision.reasons[0]);
  });

  it("does NOT apply the override for a pre-veto reason when mode is off — stays blocked", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["red_team_veto: The bull thesis ignores a deteriorating balance sheet."]
    };

    const result = resolveSocraticOverride({
      proposal,
      policy: { ...policy, socraticOverrideMode: "off" },
      portfolio,
      estimatedNotional: 900,
      decision
    });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
  });

  it("REFUSES when a hard policy reason is mixed in with the pre-veto reason", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: [
        "red_team_veto: The bull thesis ignores a deteriorating balance sheet.",
        "Order of $7000.00 exceeds available buying power $6000.00."
      ]
    };

    const result = resolveSocraticOverride({ proposal, policy, portfolio, estimatedNotional: 7_000, decision });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
    expect(result.hardReasons.some((r) => r.includes("buying power"))).toBe(true);
  });

  it("enforces the override cap on the UP-SIZED notional even for a pre-veto reason", () => {
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["deterministic_bear_veto: below-median scan score in a risk-off regime"]
    };

    // Cap = 5% of $10k NAV = $500; a $900 sized order exceeds it → refused with a cap reason.
    const result = resolveSocraticOverride({
      proposal,
      policy: { ...policy, socraticOverrideMaxPctOfNav: 5 },
      portfolio,
      estimatedNotional: 900,
      decision
    });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
    expect(result.hardReasons.some((r) => r.includes("override cap"))).toBe(true);
  });
});

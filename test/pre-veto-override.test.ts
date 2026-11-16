import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { resolveSocraticOverride } from "../src/lib/socratic-runtime";
import { preVetoTaggedOpeningWillPlace } from "../src/lib/strategy";
import type { PolicyDecision, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

/**
 * Pre-veto override (Option 2) — unit test of the fold-in + resolveSocraticOverride path.
 *
 * The two PRE-POLICY vetoes (deterministic-bear filter, approval-time Red Team) no longer DROP a
 * candidate; they TAG it with `preVetoReasons`. strategy.ts then folds those reasons into the single
 * sized PolicyDecision (append to reasons + set approved:false) immediately before the ONE
 * resolveSocraticOverride call. Because `isHardGateReason("deterministic_bear_veto: …")` and
 * `isHardGateReason("red_team_veto: …")` are both false, an `autonomyOverride` thesis can pass them on
 * an OPENING, subject to socraticOverrideMode and the override cap. This test reproduces the fold-in
 * transformation verbatim and asserts the resolution end-to-end.
 */

const portfolio: Portfolio = {
  accountNumber: "acct",
  totalMarketValue: 10_000,
  buyingPower: 6_000,
  equityMarketValue: 4_000,
  optionMarketValue: 0,
  cash: 6_000
};

const basePolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  accountNumber: "acct",
  strategyAuthority: "decide",
  socraticOverrideMode: "execute",
  socraticOverrideMaxPctOfNav: 100,
  maxOrderNotional: 500
};

function makeOpening(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    dollarAmount: 400,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Discounted quality name; the deterministic veto looks like a transient risk-off overreaction.",
    tradeThesisTag: "Mean-Reversion",
    entryMarketRegime: "Crisis (Extreme Volatility)",
    confidenceScore: 84,
    autonomyOverride: {
      requested: true,
      thesis: "The below-median scan score reflects a liquidity-driven selloff, not thesis impairment; I want to buy the discount.",
      preferenceConflicts: ["deterministic bear veto"],
      invalidation: "The name breaks its 52-week low on rising volume with a company-specific catalyst."
    },
    ...overrides
  };
}

/**
 * Mirror of the fold-in block in strategy.ts (before resolveSocraticOverride): append the advisory
 * pre-veto reasons to the base decision and force approved:false.
 */
function foldInPreVeto(base: PolicyDecision, proposal: TradeProposal): PolicyDecision {
  if (!proposal.preVetoReasons?.length) return base;
  return { ...base, approved: false, reasons: [...base.reasons, ...proposal.preVetoReasons] };
}

describe("pre-veto override — fold-in then resolveSocraticOverride", () => {
  it("a tagged opening with a requested thesis in execute mode resolves to APPROVED", () => {
    const proposal = makeOpening({
      preVetoReasons: ["deterministic_bear_veto: Crisis (Extreme Volatility) regime with below-median scan score (40.0 < median 70.0); risk-on entry too weak"]
    });
    // The policy gate itself passed (no owner-preference conflicts) — the only blocking reason is the
    // folded pre-veto, exactly the pre-policy-veto-in-isolation case.
    const baseDecision: PolicyDecision = { approved: true, reasons: [] };
    const decision = foldInPreVeto(baseDecision, proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toHaveLength(1);

    const result = resolveSocraticOverride({ proposal, policy: basePolicy, portfolio, estimatedNotional: 400, decision });

    expect(result.applied).toBe(true);
    expect(result.decision.approved).toBe(true);
    expect(result.routeToHuman).toBe(false); // execute mode self-executes
    expect(result.hardReasons).toHaveLength(0);
    expect(result.decision.socraticOverride?.conflicts).toContain(proposal.preVetoReasons![0]);
  });

  it("a red-team-tagged opening resolves to APPROVED and carries the veto reason as an overridable conflict", () => {
    const proposal = makeOpening({
      preVetoReasons: ["red_team_veto: The bull case leans on a single beat and ignores a fresh guidance cut."]
    });
    const decision = foldInPreVeto({ approved: true, reasons: [] }, proposal);

    const result = resolveSocraticOverride({ proposal, policy: basePolicy, portfolio, estimatedNotional: 400, decision });

    expect(result.applied).toBe(true);
    expect(result.conflicts).toContain(proposal.preVetoReasons![0]);
  });

  it("propose mode routes the overridden opening to human review (routeToHuman)", () => {
    const proposal = makeOpening({
      preVetoReasons: ["deterministic_bear_veto: below-median scan score in a risk-off regime"]
    });
    const decision = foldInPreVeto({ approved: true, reasons: [] }, proposal);

    const result = resolveSocraticOverride({
      proposal,
      policy: { ...basePolicy, socraticOverrideMode: "propose" },
      portfolio,
      estimatedNotional: 400,
      decision
    });

    expect(result.applied).toBe(true);
    expect(result.routeToHuman).toBe(true);
  });

  it("mode 'off' keeps the tagged opening BLOCKED", () => {
    const proposal = makeOpening({
      preVetoReasons: ["red_team_veto: The bull thesis ignores a deteriorating balance sheet."]
    });
    const decision = foldInPreVeto({ approved: true, reasons: [] }, proposal);

    const result = resolveSocraticOverride({
      proposal,
      policy: { ...basePolicy, socraticOverrideMode: "off" },
      portfolio,
      estimatedNotional: 400,
      decision
    });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
  });

  it("without a requested autonomyOverride the tagged opening stays BLOCKED", () => {
    const proposal = makeOpening({
      autonomyOverride: undefined,
      preVetoReasons: ["deterministic_bear_veto: below-median scan score in a risk-off regime"]
    });
    const decision = foldInPreVeto({ approved: true, reasons: [] }, proposal);

    const result = resolveSocraticOverride({ proposal, policy: basePolicy, portfolio, estimatedNotional: 400, decision });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
  });

  it("a HARD policy reason mixed with a pre-veto reason still REFUSES the whole override", () => {
    const proposal = makeOpening({
      preVetoReasons: ["red_team_veto: The bull thesis ignores a deteriorating balance sheet."]
    });
    // Base policy decision already blocked on a hard buying-power gate; pre-veto folds on top.
    const baseDecision: PolicyDecision = {
      approved: false,
      reasons: ["Order of $7000.00 exceeds available buying power $6000.00."]
    };
    const decision = foldInPreVeto(baseDecision, proposal);

    const result = resolveSocraticOverride({ proposal, policy: basePolicy, portfolio, estimatedNotional: 7_000, decision });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
    expect(result.hardReasons.some((r) => r.includes("buying power"))).toBe(true);
  });

  it("a tagged EXIT never overrides (openings-only) — stays blocked even in execute mode", () => {
    const proposal = makeOpening({
      side: "sell",
      preVetoReasons: ["deterministic_bear_veto: this should never reach an exit, but assert openings-only anyway"]
    });
    const decision = foldInPreVeto({ approved: true, reasons: [] }, proposal);

    const result = resolveSocraticOverride({ proposal, policy: basePolicy, portfolio, estimatedNotional: 400, decision });

    expect(result.applied).toBe(false);
    expect(result.decision.approved).toBe(false);
  });
});

describe("preVetoTaggedOpeningWillPlace — sell-to-fund notional exclusion (ISSUE 1 regression)", () => {
  // A pre-veto-TAGGED opening that won't auto-execute must NOT count toward intendedOpeningNotional,
  // or sellToFundBuy:"automated" liquidates real holdings to fund a buy the fold-in then blocks. It
  // auto-executes ONLY in execute mode with a requested override thesis (propose routes to human;
  // off/no-thesis stays blocked). Untagged openings are unaffected.
  it("an UNTAGGED opening always counts, in any mode", () => {
    const untagged = makeOpening({ preVetoReasons: undefined });
    for (const mode of ["execute", "propose", "off"] as const) {
      expect(preVetoTaggedOpeningWillPlace(untagged, mode)).toBe(true);
    }
  });

  it("a tagged opening WITHOUT a valid override thesis is excluded (would be blocked → funds $0)", () => {
    const tagged = makeOpening({ preVetoReasons: ["deterministic_bear_veto: risk-on entry too weak"], autonomyOverride: undefined });
    for (const mode of ["execute", "propose", "off"] as const) {
      expect(preVetoTaggedOpeningWillPlace(tagged, mode)).toBe(false);
    }
  });

  it("a tagged opening counts ONLY in execute mode with a requested thesis (auto-executes)", () => {
    const tagged = makeOpening({ preVetoReasons: ["deterministic_bear_veto: risk-on entry too weak"] }); // makeOpening supplies a valid autonomyOverride
    expect(preVetoTaggedOpeningWillPlace(tagged, "execute")).toBe(true);
    expect(preVetoTaggedOpeningWillPlace(tagged, "propose")).toBe(false); // routed via requiresHumanReview elsewhere, not counted here
    expect(preVetoTaggedOpeningWillPlace(tagged, "off")).toBe(false);
  });

  it("a blank thesis does not qualify even in execute mode", () => {
    const tagged = makeOpening({ preVetoReasons: ["red_team_veto: weak"], autonomyOverride: { requested: true, thesis: "   " } });
    expect(preVetoTaggedOpeningWillPlace(tagged, "execute")).toBe(false);
  });
});

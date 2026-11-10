import { describe, expect, it } from "vitest";
import { isEscalationRegime } from "../src/lib/regime-watch";
import { MARKET_REGIME_LABELS } from "../src/lib/market-regime";
import type { MarketFactorBreakdown, MarketQuote, TradeProposal } from "../src/lib/types";
import { deterministicBearFilter } from "../src/lib/strategy-risk";

/**
 * Gate-level regression for the risk lane's typed-`MarketRegime` adoption: the crisis cap
 * (policy.ts), the bear filter's risk-off veto (strategy.ts `deterministicBearFilter`), and the
 * escalation gate (regime-watch.ts `isEscalationRegime`) now classify the persisted regime label
 * through the SHARED `regimeFromLabel` + typed predicates in ./market-regime instead of three
 * independent substring/`startsWith` rules. `test/market-regime.test.ts` pins the predicates in
 * isolation; this file pins them AT THE GATES, so a future refactor that reverts a gate to an
 * ad-hoc substring rule (re-introducing the desync the typed enum exists to prevent) fails here.
 *
 * Two behaviors are load-bearing and easy to regress:
 *  1. The "Cautious (Inverted Curve)" ASYMMETRY — it trips the crisis cap but must NOT trip the
 *     bear filter's risk-off veto (the exact cross-gate inconsistency the composite review flagged).
 *  2. The non-canonical HARDENING — a free-text label ("Crisis", "risk-off", "Inverted") that the
 *     old substring rules would have matched now resolves to `unknown` and reads non-escalating,
 *     so an unrecognized string can never silently trip a risk gate. (Production always persists a
 *     canonical label via `determineMarketRegime`; this only affects stray/free-text tags.)
 */

function makeProposal(overrides: Partial<TradeProposal>): TradeProposal {
  return {
    symbol: "META",
    side: "buy",
    type: "market",
    quantity: undefined,
    dollarAmount: 1000,
    limitPrice: undefined,
    stopPrice: undefined,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Test rationale",
    tradeThesisTag: "momentum_breakout",
    entryMarketRegime: "Neutral (Normal Volatility)",
    confidenceScore: 60,
    ...overrides
  };
}

function makeQuote(symbol: string, score: number): MarketQuote {
  const factorBreakdown = {
    liquidity: 50, momentum: 50, value: 50, quality: 50, volatility: 50,
    sentiment: 50, positioning: 50, diversification: 50, weightedTotal: score
  } as unknown as MarketFactorBreakdown;
  return {
    symbol, score, factorBreakdown,
    price: 100, change: 0, changePercent: 0, volume: 1_000_000,
    marketCap: 1e12, peRatio: null, eps: null, high52w: 110, low52w: 80, cached: false
  } as unknown as MarketQuote;
}

/** A below-median buy on META (score 40 < median 70): the only thing standing between it and a
 *  risk-off veto is whether the regime classifies as risk-off. */
function belowMedianBuy() {
  const quotes = [makeQuote("AAPL", 80), makeQuote("NVDA", 70), makeQuote("META", 40)];
  const proposal = makeProposal({ symbol: "META" });
  return { quotes, proposal };
}

describe("bear-filter risk-off veto — typed regime adoption", () => {
  it("TAGS (advisory, keeps) a below-median buy in canonical Crisis and Risk-Off regimes", () => {
    for (const label of [MARKET_REGIME_LABELS.crisis, MARKET_REGIME_LABELS["risk-off"]]) {
      const { quotes, proposal } = belowMedianBuy();
      const { kept, vetoed } = deterministicBearFilter([proposal], [], quotes, label);
      // Advisory pre-veto (tag-not-drop): KEPT + tagged, still reported in `vetoed` for telemetry.
      expect(kept).toHaveLength(1);
      expect(kept[0].preVetoReasons?.[0]).toMatch(/^deterministic_bear_veto: /);
      expect(kept[0].preVetoReasons?.[0]).toContain(label);
      expect(vetoed).toHaveLength(1);
      // The veto reason still quotes the ORIGINAL label (not the enum key).
      expect(vetoed[0].reason).toContain(label);
    }
  });

  it("does NOT veto in 'Cautious (Inverted Curve)' — the documented asymmetry (crisis cap only)", () => {
    const { quotes, proposal } = belowMedianBuy();
    const { kept, vetoed } = deterministicBearFilter([proposal], [], quotes, MARKET_REGIME_LABELS["cautious-inverted"]);
    expect(kept).toHaveLength(1);
    expect(vetoed).toHaveLength(0);
  });

  it("does NOT veto in calm canonical regimes (Neutral / Risk-On)", () => {
    for (const label of [MARKET_REGIME_LABELS.neutral, MARKET_REGIME_LABELS["risk-on"]]) {
      const { quotes, proposal } = belowMedianBuy();
      const { kept } = deterministicBearFilter([proposal], [], quotes, label);
      expect(kept).toHaveLength(1);
    }
  });

  it("hardening: a non-canonical free-text label no longer accidentally trips the risk-off veto", () => {
    // Old `startsWith("Crisis")/startsWith("Risk-Off")` would have vetoed "Crisis" and "Risk-Off …";
    // the typed path maps any non-canonical string to `unknown` (non-risk-off), so the buy survives.
    for (const stray of ["Crisis", "Risk-Off", "risk-off", "Inverted", "Active Risk Check"]) {
      const { quotes, proposal } = belowMedianBuy();
      const { kept, vetoed } = deterministicBearFilter([proposal], [], quotes, stray);
      expect(kept).toHaveLength(1);
      expect(vetoed).toHaveLength(0);
    }
  });
});

describe("isEscalationRegime — typed regime adoption", () => {
  it("escalates on crisis / risk-off / cautious-inverted canonical labels", () => {
    expect(isEscalationRegime(MARKET_REGIME_LABELS.crisis)).toBe(true);
    expect(isEscalationRegime(MARKET_REGIME_LABELS["risk-off"])).toBe(true);
    expect(isEscalationRegime(MARKET_REGIME_LABELS["cautious-inverted"])).toBe(true);
  });

  it("does not escalate on calm / unknown canonical labels", () => {
    expect(isEscalationRegime(MARKET_REGIME_LABELS.neutral)).toBe(false);
    expect(isEscalationRegime(MARKET_REGIME_LABELS["risk-on"])).toBe(false);
    expect(isEscalationRegime(MARKET_REGIME_LABELS.unknown)).toBe(false);
  });

  it("hardening: non-canonical free-text labels read non-escalating", () => {
    for (const stray of ["Crisis", "risk-off", "Inverted", "Neutral (Moderate)", "Bull", "Tech-Bull", ""]) {
      expect(isEscalationRegime(stray)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyMarketRegime,
  isCrisisOrInvertedMarketRegime,
  isEscalationMarketRegime,
  isRiskOffFilterRegime,
  MARKET_REGIME_LABELS,
  MARKET_REGIME_SEVERITY,
  regimeFromLabel,
  type MarketRegime
} from "../src/lib/market-regime";

/**
 * The typed enum + severity is the S-effort enabler under vol-targeting / continuous taper /
 * term-structure triggers (composite review E/high/S, "Typed regime enum + numeric severity —
 * kill the string-coupling"). Before this module existed, `isCrisisOrInvertedRegime` (policy.ts)
 * substring-matched "crisis"/"inverted", `deterministicBearFilter` (strategy.ts) checked
 * `startsWith("Crisis")/startsWith("Risk-Off")`, and `isEscalationRegime` (regime-watch.ts) checked
 * yet a third set — so "Cautious (Inverted Curve)" matched the crisis cap but NOT the bear filter,
 * and a relabel could silently desync one gate from another with no type error. This test pins
 * down, for every canonical label, exactly which of the three gate behaviors it should trip — the
 * regression a future relabel/refactor must not break.
 */
describe("regimeFromLabel — every canonical persisted label round-trips to its enum", () => {
  it("maps each MARKET_REGIME_LABELS entry back to its own enum key", () => {
    for (const [regime, label] of Object.entries(MARKET_REGIME_LABELS) as Array<[MarketRegime, string]>) {
      expect(regimeFromLabel(label)).toBe(regime);
    }
  });

  it("falls back to 'unknown' for free-text / unrecognized labels (never guesses a match)", () => {
    expect(regimeFromLabel("Bull")).toBe("unknown");
    expect(regimeFromLabel("Tech-Bull")).toBe("unknown");
    expect(regimeFromLabel("Active Risk Check")).toBe("unknown");
    expect(regimeFromLabel(undefined)).toBe("unknown");
    expect(regimeFromLabel("")).toBe("unknown");
  });
});

describe("per-label gate behavior matrix (crisisCap, bearRiskOff, escalation)", () => {
  const expected: Record<MarketRegime, { crisisCap: boolean; bearRiskOff: boolean; escalation: boolean; severity: number }> = {
    crisis: { crisisCap: true, bearRiskOff: true, escalation: true, severity: 1 },
    "risk-off": { crisisCap: false, bearRiskOff: true, escalation: true, severity: 0.66 },
    "cautious-inverted": { crisisCap: true, bearRiskOff: false, escalation: true, severity: 0.33 },
    neutral: { crisisCap: false, bearRiskOff: false, escalation: false, severity: 0 },
    "risk-on": { crisisCap: false, bearRiskOff: false, escalation: false, severity: 0 },
    unknown: { crisisCap: false, bearRiskOff: false, escalation: false, severity: 0 }
  };

  it.each(Object.keys(expected) as MarketRegime[])("regime %s trips exactly its documented gates", (regime) => {
    const want = expected[regime];
    expect(isCrisisOrInvertedMarketRegime(regime)).toBe(want.crisisCap);
    expect(isRiskOffFilterRegime(regime)).toBe(want.bearRiskOff);
    expect(isEscalationMarketRegime(regime)).toBe(want.escalation);
    expect(MARKET_REGIME_SEVERITY[regime]).toBe(want.severity);
  });

  it("severity is monotone non-increasing crisis > risk-off > cautious-inverted >= neutral/risk-on/unknown", () => {
    expect(MARKET_REGIME_SEVERITY.crisis).toBeGreaterThan(MARKET_REGIME_SEVERITY["risk-off"]);
    expect(MARKET_REGIME_SEVERITY["risk-off"]).toBeGreaterThan(MARKET_REGIME_SEVERITY["cautious-inverted"]);
    expect(MARKET_REGIME_SEVERITY["cautious-inverted"]).toBeGreaterThan(MARKET_REGIME_SEVERITY.neutral);
    expect(MARKET_REGIME_SEVERITY.neutral).toBe(MARKET_REGIME_SEVERITY["risk-on"]);
    expect(MARKET_REGIME_SEVERITY.neutral).toBe(MARKET_REGIME_SEVERITY.unknown);
  });

  it("documents the exact 'Cautious (Inverted Curve)' asymmetry the composite review flagged: trips the crisis cap but NOT the bear filter's risk-off veto", () => {
    const regime = regimeFromLabel(MARKET_REGIME_LABELS["cautious-inverted"]);
    expect(isCrisisOrInvertedMarketRegime(regime)).toBe(true);
    expect(isRiskOffFilterRegime(regime)).toBe(false);
    expect(isEscalationMarketRegime(regime)).toBe(true);
  });
});

describe("classifyMarketRegime", () => {
  const base = { asOf: "2026-06-16", vix: "15.00", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" };

  it("returns {regime, severity} consistent with MARKET_REGIME_SEVERITY for each bucket", () => {
    expect(classifyMarketRegime({ ...base, vix: "35" })).toEqual({ regime: "crisis", severity: 1 });
    expect(classifyMarketRegime({ ...base, vix: "24" })).toEqual({ regime: "risk-off", severity: 0.66 });
    expect(classifyMarketRegime({ ...base, vix: "12", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toEqual({
      regime: "risk-on",
      severity: 0
    });
    expect(classifyMarketRegime({ ...base, vix: "16", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toEqual({
      regime: "neutral",
      severity: 0
    });
    expect(classifyMarketRegime({ ...base, vix: "12" })).toEqual({ regime: "cautious-inverted", severity: 0.33 });
    expect(classifyMarketRegime({ ...base, asOf: "unavailable" })).toEqual({ regime: "unknown", severity: 0 });
  });
});

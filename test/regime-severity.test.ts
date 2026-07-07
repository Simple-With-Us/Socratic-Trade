import { describe, expect, it } from "vitest";
import {
  applyRegimeHysteresis,
  bucketFromSeverity,
  scoreRegimeSeverity,
  type HysteresisState,
  type RegimeSeverityInputs
} from "../src/lib/regime-severity";
import { MARKET_REGIME_SEVERITY, type MarketRegime } from "../src/lib/market-regime";

/**
 * Multi-signal regime severity (MONET risk lane, docs/reviews/2026-07-04-expert-design-review.md
 * E1/E4): a continuous [0,1] blend of VIX, VIX term structure, HY credit spread, the 2s10s curve,
 * and breadth, replacing the coarse per-bucket MARKET_REGIME_SEVERITY constant additively. Mirrors
 * test/market-regime.test.ts's fixture style. The money-path invariant this suite exists to pin:
 * a thin/missing macro feed must NEVER read as a confident high-severity regime.
 */

// A "fully stressed" baseline used by the monotonicity tests so varying one axis at a time is
// unambiguous — every other signal is pinned at its calmest reading.
const calm: RegimeSeverityInputs = {
  vix: 12,
  vixTermStructure: 0.95,
  hyCreditSpread: 3.0,
  curve2s10s: 0.5,
  breadthPct: 55
};

describe("scoreRegimeSeverity — monotonicity (one axis at a time)", () => {
  it("VIX 12 -> 40 strictly increases severity", () => {
    const severities = [12, 20, 28, 34, 40].map((vix) => scoreRegimeSeverity({ ...calm, vix }).severity);
    for (let i = 1; i < severities.length; i++) {
      expect(severities[i]).toBeGreaterThan(severities[i - 1]);
    }
  });

  it("HY credit spread 3 -> 8 strictly increases severity", () => {
    const severities = [3, 4.5, 6, 7, 8].map((hyCreditSpread) => scoreRegimeSeverity({ ...calm, hyCreditSpread }).severity);
    for (let i = 1; i < severities.length; i++) {
      expect(severities[i]).toBeGreaterThan(severities[i - 1]);
    }
  });

  it("VIX term structure 0.95 -> 1.15 (backwardation) strictly increases severity", () => {
    const severities = [0.95, 1.02, 1.08, 1.12, 1.15].map((vixTermStructure) =>
      scoreRegimeSeverity({ ...calm, vixTermStructure }).severity
    );
    for (let i = 1; i < severities.length; i++) {
      expect(severities[i]).toBeGreaterThan(severities[i - 1]);
    }
  });

  it("breadth 55 -> 25 (fewer advancing) strictly increases severity", () => {
    const severities = [55, 45, 38, 30, 25].map((breadthPct) => scoreRegimeSeverity({ ...calm, breadthPct }).severity);
    for (let i = 1; i < severities.length; i++) {
      expect(severities[i]).toBeGreaterThan(severities[i - 1]);
    }
  });

  it("2s10s curve +0.5 -> -1.0 (inverting) strictly increases severity", () => {
    const severities = [0.5, 0.1, -0.25, -0.6, -1.0].map((curve2s10s) => scoreRegimeSeverity({ ...calm, curve2s10s }).severity);
    for (let i = 1; i < severities.length; i++) {
      expect(severities[i]).toBeGreaterThan(severities[i - 1]);
    }
  });
});

describe("scoreRegimeSeverity — missing-signal invariance", () => {
  it("dropping a signal renormalizes weights (present-only mean)", () => {
    // VIX=40 (max contribution 1) + HY=3.0 (min contribution 0) with equal-ish weights should
    // land strictly between 0 and 1, and dropping the calm HY signal should raise severity
    // toward the VIX-only contribution since the drag from a 0-contribution signal is removed.
    const withBoth = scoreRegimeSeverity({ vix: 40, hyCreditSpread: 3.0, breadthPct: 55 });
    const vixOnlyPlusBreadth = scoreRegimeSeverity({ vix: 40, breadthPct: 55 });
    expect(vixOnlyPlusBreadth.severity).toBeGreaterThan(withBoth.severity);
  });

  it("passing only VIX (plus one more signal to clear minSignals) yields the VIX sub-score's own weighted share", () => {
    const result = scoreRegimeSeverity({ vix: 40, breadthPct: 55 }, { minSignals: 1 });
    // With only VIX present and minSignals satisfied, severity should equal the VIX contribution
    // exactly (weight cancels out in a single-signal weighted mean).
    const vixOnly = scoreRegimeSeverity({ vix: 40 }, { minSignals: 1 });
    expect(vixOnly.severity).toBeCloseTo(1, 5); // ramp(40, 12, 40) = 1
    expect(vixOnly.signalCount).toBe(1);
    expect(vixOnly.contributingSignals).toEqual(["vix"]);
  });

  it("hyCreditSpread1wChange is accepted but dropped (not scored in v1)", () => {
    const withChange = scoreRegimeSeverity({ ...calm, hyCreditSpread1wChange: 2.5 });
    const withoutChange = scoreRegimeSeverity(calm);
    expect(withChange.severity).toBe(withoutChange.severity);
    expect(withChange.contributingSignals).not.toContain("hyCreditSpread1wChange");
  });
});

describe("scoreRegimeSeverity — degraded floor (thin/missing feed invariant)", () => {
  it("signalCount < minSignals falls back to baseRegime severity, degraded=true", () => {
    const result = scoreRegimeSeverity({ vix: 40, baseRegime: "risk-off" }, { minSignals: 2 });
    expect(result.degraded).toBe(true);
    expect(result.severity).toBe(MARKET_REGIME_SEVERITY["risk-off"]);
    expect(result.regime).toBe("risk-off");
  });

  it("a single extreme VIX reading alone (below minSignals) never fabricates crisis-level severity", () => {
    // Without a baseRegime anchor this must read as unknown/0, NOT high severity, even though
    // VIX=40 alone would ramp to contribution 1.
    const result = scoreRegimeSeverity({ vix: 40 });
    expect(result.degraded).toBe(true);
    expect(result.severity).toBe(0);
    expect(result.regime).toBe("unknown");
  });

  it("empty inputs => severity 0 / regime unknown (the 'missing feed never reads as elevated risk' invariant)", () => {
    const result = scoreRegimeSeverity({});
    expect(result.degraded).toBe(true);
    expect(result.severity).toBe(0);
    expect(result.regime).toBe("unknown");
    expect(result.signalCount).toBe(0);
    expect(result.contributingSignals).toEqual([]);
  });
});

describe("scoreRegimeSeverity — bucket boundaries", () => {
  // Construct inputs that push ALL signals to the same contribution level c, so the blended
  // severity equals c regardless of weights, letting us test exact band edges deterministically.
  function atUniformContribution(c: number): RegimeSeverityInputs {
    return {
      vix: 12 + c * (40 - 12),
      vixTermStructure: 0.95 + c * (1.15 - 0.95),
      hyCreditSpread: 3.0 + c * (8.0 - 3.0),
      curve2s10s: 0.5 + c * (-1.0 - 0.5),
      breadthPct: 55 + c * (25 - 55)
    };
  }

  // In-band values kept away from the exact band edges: atUniformContribution engineers inputs to
  // TARGET a severity, but the signal ramps don't produce float-EXACT results, so an exact-edge value
  // (e.g. 0.5) can land a hair on either side. The edge INCLUSIVITY is pinned directly below via
  // bucketFromSeverity with exact severities; here we only assert the end-to-end blend lands in-band.
  const cases: Array<{ c: number; expected: MarketRegime }> = [
    { c: 0.85, expected: "crisis" }, // in [0.75, 1]
    { c: 0.6, expected: "risk-off" }, // in [0.50, 0.75)
    { c: 0.4, expected: "cautious-inverted" }, // in [0.28, 0.50)
    { c: 0.18, expected: "neutral" }, // in [0.10, 0.28)
    { c: 0.05, expected: "risk-on" } // < 0.10 with breadth present
  ];

  it.each(cases)("uniform contribution $c blends into the $expected band", ({ c, expected }) => {
    const result = scoreRegimeSeverity(atUniformContribution(c));
    expect(result.severity).toBeCloseTo(c, 5);
    expect(result.regime).toBe(expected);
  });

  it("bucketFromSeverity — lower band edges are INCLUSIVE (exact severities)", () => {
    expect(bucketFromSeverity(0.75, true)).toBe("crisis");
    expect(bucketFromSeverity(0.7499, true)).toBe("risk-off");
    expect(bucketFromSeverity(0.5, true)).toBe("risk-off");
    expect(bucketFromSeverity(0.4999, true)).toBe("cautious-inverted");
    expect(bucketFromSeverity(0.28, true)).toBe("cautious-inverted");
    expect(bucketFromSeverity(0.2799, true)).toBe("neutral");
    expect(bucketFromSeverity(0.1, true)).toBe("neutral"); // 0.1 is NOT < 0.10 → neutral
    expect(bucketFromSeverity(0.09, true)).toBe("risk-on"); // < 0.10 with breadth
    expect(bucketFromSeverity(0.09, false)).toBe("neutral"); // < 0.10 WITHOUT breadth → neutral (asymmetry)
  });

  it("< 0.10 severity WITHOUT breadth present reads neutral, not risk-on (asymmetry requires positive breadth evidence)", () => {
    const result = scoreRegimeSeverity({ vix: 12, hyCreditSpread: 3.0 });
    expect(result.severity).toBeLessThan(0.1);
    expect(result.regime).toBe("neutral");
  });
});

describe("applyRegimeHysteresis", () => {
  const crisisInputs: RegimeSeverityInputs = { vix: 40, hyCreditSpread: 8.0 };
  const neutralInputs: RegimeSeverityInputs = { vix: 12, hyCreditSpread: 3.0 };

  it("a 1-tick spike above a band does NOT flip regime (minTicksToFlip=2 default)", () => {
    const fresh = scoreRegimeSeverity(neutralInputs);
    expect(fresh.regime).toBe("neutral");

    const prior: HysteresisState = { lastRegime: "neutral", ticksInPendingBand: 0, pendingRegime: null };
    const spike = scoreRegimeSeverity(crisisInputs);
    expect(spike.regime).toBe("crisis");

    const { result, nextState } = applyRegimeHysteresis(spike, prior);
    // Single tick: not confirmed yet, still reports the last confirmed regime.
    expect(result.regime).toBe("neutral");
    expect(nextState.pendingRegime).toBe("crisis");
    expect(nextState.ticksInPendingBand).toBe(1);
  });

  it("minTicksToFlip consecutive ticks DOES flip the regime", () => {
    let state: HysteresisState = { lastRegime: "neutral", ticksInPendingBand: 0, pendingRegime: null };
    const spike = scoreRegimeSeverity(crisisInputs);

    // Tick 1: pending, not yet flipped.
    let applied = applyRegimeHysteresis(spike, state, 2);
    expect(applied.result.regime).toBe("neutral");
    state = applied.nextState;

    // Tick 2: confirmed, flips.
    applied = applyRegimeHysteresis(spike, state, 2);
    expect(applied.result.regime).toBe("crisis");
    state = applied.nextState;
    expect(state.lastRegime).toBe("crisis");
    expect(state.pendingRegime).toBeNull();
  });

  it("falling back down obeys the same tick count", () => {
    let state: HysteresisState = { lastRegime: "crisis", ticksInPendingBand: 0, pendingRegime: null };
    const calmRead = scoreRegimeSeverity(neutralInputs);
    expect(calmRead.regime).toBe("neutral");

    let applied = applyRegimeHysteresis(calmRead, state, 2);
    expect(applied.result.regime).toBe("crisis"); // still pending
    state = applied.nextState;

    applied = applyRegimeHysteresis(calmRead, state, 2);
    expect(applied.result.regime).toBe("neutral"); // confirmed after 2 ticks
    state = applied.nextState;
    expect(state.lastRegime).toBe("neutral");
  });

  it("a non-matching third read resets the pending band count (must be consecutive)", () => {
    let state: HysteresisState = { lastRegime: "neutral", ticksInPendingBand: 0, pendingRegime: null };
    const spike = scoreRegimeSeverity(crisisInputs);
    const riskOff = scoreRegimeSeverity({ vix: 24 });

    let applied = applyRegimeHysteresis(spike, state, 2);
    expect(applied.nextState.pendingRegime).toBe("crisis");
    expect(applied.nextState.ticksInPendingBand).toBe(1);
    state = applied.nextState;

    // A DIFFERENT pending regime read next tick resets the pending counter to 1 for the new band.
    applied = applyRegimeHysteresis(riskOff, state, 2);
    expect(applied.result.regime).toBe("neutral"); // still not confirmed
    expect(applied.nextState.pendingRegime).toBe(riskOff.regime);
    expect(applied.nextState.ticksInPendingBand).toBe(1);
  });

  it("severity in the result is always the fresh instantaneous value, even when the bucket is hysteresis-held", () => {
    const state: HysteresisState = { lastRegime: "neutral", ticksInPendingBand: 0, pendingRegime: null };
    const spike = scoreRegimeSeverity(crisisInputs);
    const { result } = applyRegimeHysteresis(spike, state, 2);
    expect(result.regime).toBe("neutral"); // held
    expect(result.severity).toBe(spike.severity); // but severity itself is not smoothed
  });
});

describe("scoreRegimeSeverity — weight override", () => {
  it("custom opts.weights changes the blend deterministically", () => {
    const inputs: RegimeSeverityInputs = { vix: 40, hyCreditSpread: 3.0 };
    const defaultWeighted = scoreRegimeSeverity(inputs);
    const vixHeavy = scoreRegimeSeverity(inputs, { weights: { vix: 10, hyCreditSpread: 0.01 } });
    // Weighting VIX (contribution 1) far more heavily than HY (contribution 0) should pull the
    // blended severity up toward 1, above the default-weighted blend.
    expect(vixHeavy.severity).toBeGreaterThan(defaultWeighted.severity);
    expect(vixHeavy.severity).toBeGreaterThan(0.9);
  });
});

import { describe, expect, it } from "vitest";
import {
  computeFactorICs,
  computePerFactorIC,
  computeCompositeIC,
  pairedICDiffStats,
  deriveWeightsFromICs,
  deriveWeightsFromIC,
  splitWalkForward,
  formatOosWindow,
  adjustReturns,
  buildEquityCurve,
  maxDrawdownOfCurve,
  isPointInTimeForwardExit,
  MARKET_FACTORS,
  type EquityCurvePoint,
  type FactorIC,
  type FactorObservation
} from "../src/lib/backtest";
import { DEFAULT_SCORING_WEIGHTS } from "../src/lib/defaults";
import type { MarketFactor } from "../src/lib/types";

// Pure-function tests only — no db, no network. computeFactorICs and deriveWeightsFromICs
// are Date.now()-free, so these fixtures fully determine the outputs.

/** Build a full sub-score map, defaulting unspecified factors to a neutral 0. */
function subScores(partial: Partial<Record<MarketFactor, number>>): Record<MarketFactor, number> {
  const out = {} as Record<MarketFactor, number>;
  for (const factor of MARKET_FACTORS) out[factor] = partial[factor] ?? 0;
  return out;
}

function obs(
  date: string,
  symbol: string,
  forwardReturn: number,
  scores: Partial<Record<MarketFactor, number>>
): FactorObservation {
  return { date, symbol, forwardReturn, subScores: subScores(scores) };
}

function icFor(ics: FactorIC[], factor: MarketFactor): FactorIC {
  const found = ics.find((entry) => entry.factor === factor);
  if (!found) throw new Error(`missing IC for ${factor}`);
  return found;
}

describe("computeFactorICs", () => {
  it("returns one entry per market factor in canonical order", () => {
    const ics = computeFactorICs([]);
    expect(ics.map((entry) => entry.factor)).toEqual(MARKET_FACTORS);
    // Empty input → every factor has ic 0 and n 0 (no contributing dates).
    for (const entry of ics) {
      expect(entry).toMatchObject({ ic: 0, n: 0 });
    }
  });

  it("scores a perfectly monotone factor at IC +1 and its inverse at -1", () => {
    // Within one date: momentum rises with return, value falls with it.
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 10, value: 90 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 20, value: 80 }),
      obs("2026-06-10", "CCC", 0.03, { momentum: 30, value: 70 }),
      obs("2026-06-10", "DDD", 0.04, { momentum: 40, value: 60 })
    ];
    const ics = computeFactorICs(observations);
    expect(icFor(ics, "momentum").ic).toBeCloseTo(1, 10);
    expect(icFor(ics, "momentum").n).toBe(1);
    expect(icFor(ics, "value").ic).toBeCloseTo(-1, 10);
  });

  it("handles ties via average ranks (tie-corrected Spearman)", () => {
    // Two names share the same sub-score; the average-rank correlation stays finite.
    const observations: FactorObservation[] = [
      obs("2026-06-11", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-11", "BBB", 0.02, { momentum: 20 }),
      obs("2026-06-11", "CCC", 0.03, { momentum: 20 }), // tie with BBB
      obs("2026-06-11", "DDD", 0.04, { momentum: 40 })
    ];
    const ic = icFor(computeFactorICs(observations), "momentum").ic;
    expect(Number.isFinite(ic)).toBe(true);
    // Monotone-with-a-tie ⇒ strongly positive but below a clean +1.
    expect(ic).toBeGreaterThan(0.9);
    expect(ic).toBeLessThan(1);
  });

  it("averages per-date ICs and counts only dates with >=2 usable names", () => {
    const observations: FactorObservation[] = [
      // Date 1: perfectly monotone → +1
      obs("2026-06-10", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 20 }),
      // Date 2: perfectly inverse → -1
      obs("2026-06-11", "AAA", 0.04, { momentum: 10 }),
      obs("2026-06-11", "BBB", 0.03, { momentum: 20 }),
      // Date 3: a single name → cannot rank, must not count
      obs("2026-06-12", "AAA", 0.05, { momentum: 99 })
    ];
    const entry = icFor(computeFactorICs(observations), "momentum");
    expect(entry.n).toBe(2);
    expect(entry.ic).toBeCloseTo(0, 10); // mean of +1 and -1
  });

  it("ignores a date where the factor sub-score has zero variance", () => {
    // All sub-scores equal ⇒ rank variance is zero ⇒ correlation undefined ⇒ date skipped.
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 50 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 50 }),
      obs("2026-06-10", "CCC", 0.03, { momentum: 50 })
    ];
    const entry = icFor(computeFactorICs(observations), "momentum");
    expect(entry.n).toBe(0);
    expect(entry.ic).toBe(0);
  });

  it("skips non-finite sub-scores and returns when counting usable names", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-10", "BBB", Number.NaN, { momentum: 20 }), // bad return → dropped
      obs("2026-06-10", "CCC", 0.03, { momentum: 30 })
    ];
    const entry = icFor(computeFactorICs(observations), "momentum");
    // Only AAA and CCC remain → still a valid 2-name date.
    expect(entry.n).toBe(1);
    expect(entry.ic).toBeCloseTo(1, 10);
  });
});

describe("deriveWeightsFromICs", () => {
  it("floors negatives at zero and normalizes positives to sum to 1", () => {
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 1 }));
    // momentum +0.3, value +0.1, quality -0.5 (floored), rest 0.
    ics.find((e) => e.factor === "momentum")!.ic = 0.3;
    ics.find((e) => e.factor === "value")!.ic = 0.1;
    ics.find((e) => e.factor === "quality")!.ic = -0.5;

    const weights = deriveWeightsFromICs(ics);
    const total = MARKET_FACTORS.reduce((sum, factor) => sum + weights[factor], 0);
    expect(total).toBeCloseTo(1, 10);
    expect(weights.momentum).toBeCloseTo(0.75, 10); // 0.3 / 0.4
    expect(weights.value).toBeCloseTo(0.25, 10); // 0.1 / 0.4
    expect(weights.quality).toBe(0); // negative → floored
    expect(weights.liquidity).toBe(0);
  });

  it("falls back to DEFAULT_SCORING_WEIGHTS when all ICs are non-positive", () => {
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: -0.2, n: 3 }));
    const weights = deriveWeightsFromICs(ics);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
    // Returns a copy, not the shared default reference (no accidental mutation).
    expect(weights).not.toBe(DEFAULT_SCORING_WEIGHTS);
  });

  it("uses a provided fallback when supplied and all ICs are non-positive", () => {
    const fallback = { ...DEFAULT_SCORING_WEIGHTS, momentum: 9 };
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 0 }));
    expect(deriveWeightsFromICs(ics, fallback)).toEqual(fallback);
  });

  it("treats a single positive factor as full weight", () => {
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 1 }));
    ics.find((e) => e.factor === "liquidity")!.ic = 0.42;
    const weights = deriveWeightsFromICs(ics);
    expect(weights.liquidity).toBeCloseTo(1, 10);
    for (const factor of MARKET_FACTORS) {
      if (factor !== "liquidity") expect(weights[factor]).toBe(0);
    }
  });
});

describe("splitWalkForward", () => {
  it("puts the first 60% of unique dates in train and the rest in test", () => {
    const observations: FactorObservation[] = [
      obs("2026-01-01", "A", 0.01, { momentum: 10 }),
      obs("2026-01-02", "A", 0.02, { momentum: 20 }),
      obs("2026-01-03", "A", 0.03, { momentum: 30 }),
      obs("2026-01-04", "A", 0.04, { momentum: 40 }),
      obs("2026-01-05", "A", 0.05, { momentum: 50 })
    ];
    const { train, test } = splitWalkForward(observations, 0.6);
    // 5 dates × 0.6 = 3 → first 3 dates in train
    expect(new Set(train.map((o) => o.date))).toEqual(new Set(["2026-01-01", "2026-01-02", "2026-01-03"]));
    expect(new Set(test.map((o) => o.date))).toEqual(new Set(["2026-01-04", "2026-01-05"]));
  });

  it("never puts the same date in both train and test, covers all observations", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 }),
      obs("2026-06-11", "A", 0.03, { momentum: 10 }),
      obs("2026-06-11", "B", 0.04, { momentum: 20 }),
      obs("2026-06-12", "A", 0.05, { momentum: 30 }),
      obs("2026-06-12", "B", 0.06, { momentum: 40 })
    ];
    const { train, test } = splitWalkForward(observations);
    const trainDates = new Set(train.map((o) => o.date));
    const testDates = new Set(test.map((o) => o.date));
    for (const d of trainDates) expect(testDates.has(d)).toBe(false);
    expect(train.length + test.length).toBe(observations.length);
  });

  it("keeps all observations in train when only 1 unique date exists", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 })
    ];
    const { train, test } = splitWalkForward(observations);
    expect(train.length).toBe(2);
    expect(test.length).toBe(0);
  });

  it("always puts at least 1 date in train even with a tiny fraction", () => {
    const dates = ["2026-06-10", "2026-06-11", "2026-06-12"];
    const observations = dates.map((d) => obs(d, "A", 0.01, { momentum: 1 }));
    const { train } = splitWalkForward(observations, 0.01);
    expect(new Set(train.map((o) => o.date)).size).toBeGreaterThanOrEqual(1);
  });
});

describe("splitWalkForward — boundary report (§6 slice 3)", () => {
  const dates = [
    "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
    "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"
  ];
  const observations = dates.map((d) => obs(d, "A", 0.01, { momentum: 1 }));

  it("reports exact fold indices with embargo only (default)", () => {
    // 10 dates × 0.7 → cutIdx 7; embargo 2 date-buckets → test starts at index 9.
    const { train, test, boundary } = splitWalkForward(observations, 0.7, 2);
    expect(boundary).toEqual({ totalDates: 10, cutIdx: 7, trainCutIdx: 7, testCutIdx: 9 });
    expect(new Set(train.map((o) => o.date)).size).toBe(7);
    expect([...new Set(test.map((o) => o.date))]).toEqual(["2026-06-10"]);
    // Derived window arithmetic: embargo = testCutIdx - cutIdx; purged = cutIdx - trainCutIdx.
    expect(boundary.testCutIdx - boundary.cutIdx).toBe(2);
    expect(boundary.cutIdx - boundary.trainCutIdx).toBe(0);
  });

  it("reports the purge shrinking the train side (P1-2 opt-in)", () => {
    const { train, boundary } = splitWalkForward(observations, 0.7, 2, { purge: true });
    expect(boundary).toEqual({ totalDates: 10, cutIdx: 7, trainCutIdx: 5, testCutIdx: 9 });
    expect(new Set(train.map((o) => o.date)).size).toBe(5);
    expect(boundary.cutIdx - boundary.trainCutIdx).toBe(2);
  });

  it("caps the embargo at the available dates", () => {
    const { test, boundary } = splitWalkForward(observations, 0.7, 50);
    expect(boundary.testCutIdx).toBe(10);
    expect(test.length).toBe(0);
  });
});

describe("formatOosWindow (§6 slice 3)", () => {
  it("renders the held-out window, train window, embargo and purge in one clause", () => {
    const clause = formatOosWindow(
      {
        trainStartDate: "2026-01-05", trainEndDate: "2026-05-29",
        embargoDates: 5, purgedTrainDates: 0,
        testStartDate: "2026-06-05", testEndDate: "2026-07-29"
      },
      34,
      78
    );
    expect(clause).toBe(
      "held-out window 2026-06-05→2026-07-29 (34 dates; train 2026-01-05→2026-05-29, 78 dates; embargo 5, purge 0)"
    );
  });
});

describe("adjustReturns", () => {
  it("subtracts cost and applies tax only to positive after-cost returns", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "WIN", 0.10, { momentum: 50 }),   // positive gain
      obs("2026-06-10", "EVEN", 0.002, { momentum: 50 }), // exactly covers cost → zero after
      obs("2026-06-10", "LOSS", -0.05, { momentum: 50 })  // loss
    ];
    const adjusted = adjustReturns(observations, { costRoundTripBps: 20, taxRate: 0.24 });
    // WIN: afterCost = 0.098; net = 0.098 × (1 − 0.24)
    expect(adjusted[0].forwardReturn).toBeCloseTo(0.098 * 0.76, 8);
    // EVEN: afterCost = 0.000; taxDrag = 0; net = 0
    expect(adjusted[1].forwardReturn).toBeCloseTo(0, 8);
    // LOSS: afterCost = −0.052; no tax on loss; net = −0.052
    expect(adjusted[2].forwardReturn).toBeCloseTo(-0.052, 8);
  });

  it("defaults to 20bps round-trip and 24% tax when no options supplied", () => {
    const [adjusted] = adjustReturns([obs("2026-06-10", "A", 0.10, { momentum: 50 })]);
    expect(adjusted.forwardReturn).toBeCloseTo((0.10 - 0.002) * 0.76, 8);
  });

  it("does not mutate the original observations", () => {
    const original: FactorObservation[] = [obs("2026-06-10", "A", 0.10, { momentum: 50 })];
    adjustReturns(original);
    expect(original[0].forwardReturn).toBe(0.10);
  });
});

describe("computeCompositeIC", () => {
  it("returns zero meanIC and zero icIR for empty input", () => {
    expect(computeCompositeIC([], DEFAULT_SCORING_WEIGHTS)).toEqual({ meanIC: 0, icIR: 0 });
  });

  it("returns IC ≈ +1 when the weighted composite perfectly predicts returns", () => {
    const allMomentum = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) allMomentum[f] = f === "momentum" ? 1 : 0;
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 }),
      obs("2026-06-10", "C", 0.03, { momentum: 30 }),
      obs("2026-06-10", "D", 0.04, { momentum: 40 })
    ];
    const { meanIC } = computeCompositeIC(observations, allMomentum);
    expect(meanIC).toBeCloseTo(1, 10);
  });

  it("returns icIR 0 when there is only one OOS date (std undefined)", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 })
    ];
    const { icIR } = computeCompositeIC(observations, DEFAULT_SCORING_WEIGHTS);
    expect(icIR).toBe(0);
  });

  it("returns a finite non-zero icIR when ICs vary across multiple dates", () => {
    const allMomentum = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) allMomentum[f] = f === "momentum" ? 1 : 0;
    const observations: FactorObservation[] = [
      // date 1: perfect +1 IC
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.04, { momentum: 40 }),
      // date 2: perfect −1 IC (inverse)
      obs("2026-06-11", "A", 0.05, { momentum: 10 }),
      obs("2026-06-11", "B", 0.01, { momentum: 40 })
    ];
    const { meanIC, icIR } = computeCompositeIC(observations, allMomentum);
    expect(meanIC).toBeCloseTo(0, 10); // mean of +1 and −1
    expect(Number.isFinite(icIR)).toBe(true);
  });
});

// Panel P0-2: the paired per-date IC-difference significance basis for the autonomous gate.
describe("pairedICDiffStats", () => {
  const momentumWeights = (() => {
    const w = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) w[f] = f === "momentum" ? 1 : 0;
    return w;
  })();
  const valueWeights = (() => {
    const w = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) w[f] = f === "value" ? 1 : 0;
    return w;
  })();

  it("returns n=0 stats for empty input", () => {
    expect(pairedICDiffStats([], momentumWeights, valueWeights)).toEqual({ n: 0, meanDiff: 0, stdDiff: 0, seDiff: 0, tStat: 0 });
  });

  it("candidate that predicts well vs a baseline that predicts poorly gives a large positive paired-t", () => {
    // Momentum (candidate) ranks strongly with return (~+1 IC/date); value (baseline) is much weaker or
    // inverse. Each date's paired diff is a large positive number; a little per-date jitter keeps the SE
    // finite (a t-stat is undefined at exactly-zero variance) → a large, well-defined positive t-stat.
    const observations: FactorObservation[] = [];
    for (let d = 0; d < 6; d++) {
      const date = `2026-06-${String(10 + d).padStart(2, "0")}`;
      // momentum ↑ with return (strong), value roughly inverse; symbol C's value rank flips slightly per day
      // so the baseline IC (and thus the paired diff) varies a touch date-to-date → non-zero SE.
      observations.push(obs(date, "A", 0.01, { momentum: 10, value: 40 }));
      observations.push(obs(date, "B", 0.02, { momentum: 20, value: 30 }));
      observations.push(obs(date, "C", 0.03, { momentum: 30, value: d % 2 === 0 ? 20 : 35 }));
      observations.push(obs(date, "D", 0.04, { momentum: 40, value: 10 }));
    }
    const stats = pairedICDiffStats(observations, momentumWeights, valueWeights);
    expect(stats.n).toBe(6);
    expect(stats.meanDiff).toBeGreaterThan(1.5); // candidate clearly beats baseline
    expect(stats.tStat).toBeGreaterThan(5); // finite SE from per-date jitter → large positive t
  });

  it("identical candidate and baseline weights give meanDiff 0 and tStat 0 (no significance)", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 }),
      obs("2026-06-11", "A", 0.03, { momentum: 10 }),
      obs("2026-06-11", "B", 0.05, { momentum: 20 })
    ];
    const stats = pairedICDiffStats(observations, momentumWeights, momentumWeights);
    expect(stats.meanDiff).toBeCloseTo(0, 12);
    expect(stats.tStat).toBe(0);
  });

  it("a single paired date yields tStat 0 (no SE from one point)", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10, value: 40 }),
      obs("2026-06-10", "B", 0.04, { momentum: 40, value: 10 })
    ];
    const stats = pairedICDiffStats(observations, momentumWeights, valueWeights);
    expect(stats.n).toBe(1);
    expect(stats.tStat).toBe(0);
  });

  // Codex finding #7: a UNIFORM positive diff (candidate perfectly beats an inverse baseline on every date →
  // per-date diff is a constant +2, variance 0) must be treated as SIGNIFICANT (+Infinity), NOT rejected as 0.
  it("a uniform positive zero-variance diff yields +Infinity (significant), not 0", () => {
    const observations: FactorObservation[] = [];
    for (let d = 0; d < 4; d++) {
      const date = `2026-06-${String(10 + d).padStart(2, "0")}`;
      // momentum ↑ with return (+1 IC), value ↓ with return (−1 IC) on EVERY date → diff = +2 every date.
      observations.push(obs(date, "A", 0.01, { momentum: 10, value: 40 }));
      observations.push(obs(date, "B", 0.02, { momentum: 20, value: 30 }));
      observations.push(obs(date, "C", 0.03, { momentum: 30, value: 20 }));
      observations.push(obs(date, "D", 0.04, { momentum: 40, value: 10 }));
    }
    const stats = pairedICDiffStats(observations, momentumWeights, valueWeights);
    expect(stats.n).toBe(4);
    expect(stats.meanDiff).toBeCloseTo(2, 8);
    expect(stats.seDiff).toBe(0);
    expect(stats.tStat).toBe(Infinity); // a uniformly-better candidate clears ANY finite paired-t threshold
  });

  it("a uniform NEGATIVE zero-variance diff yields -Infinity (candidate uniformly worse)", () => {
    const observations: FactorObservation[] = [];
    for (let d = 0; d < 4; d++) {
      const date = `2026-06-${String(10 + d).padStart(2, "0")}`;
      // Swap roles: candidate=momentum tracks INVERSE of return, baseline=value tracks WITH return → diff −2.
      observations.push(obs(date, "A", 0.04, { momentum: 10, value: 40 }));
      observations.push(obs(date, "B", 0.03, { momentum: 20, value: 30 }));
      observations.push(obs(date, "C", 0.02, { momentum: 30, value: 20 }));
      observations.push(obs(date, "D", 0.01, { momentum: 40, value: 10 }));
    }
    const stats = pairedICDiffStats(observations, momentumWeights, valueWeights);
    expect(stats.meanDiff).toBeCloseTo(-2, 8);
    expect(stats.tStat).toBe(-Infinity); // uniformly worse → never passes a positive threshold
  });
});

describe("buildEquityCurve", () => {
  it("selects top-K names by composite score and compounds period returns", () => {
    const allMomentum = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) allMomentum[f] = f === "momentum" ? 1 : 0;

    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.05, { momentum: 80 }), // top score
      obs("2026-06-10", "B", 0.01, { momentum: 20 }),
      obs("2026-06-11", "A", 0.03, { momentum: 70 }), // top score
      obs("2026-06-11", "B", 0.01, { momentum: 10 })
    ];
    const curve = buildEquityCurve(observations, allMomentum, new Map(), 1);
    expect(curve).toHaveLength(2);
    expect(curve[0].periodReturn).toBeCloseTo(0.05, 8); // top-1 on date 1 = A at 5%
    expect(curve[0].nNames).toBe(1);
    expect(curve[1].periodReturn).toBeCloseTo(0.03, 8); // top-1 on date 2 = A at 3%
    expect(curve[1].cumulativeReturn).toBeCloseTo(1.05 * 1.03 - 1, 8);
  });

  it("includes SPY benchmark returns and cumulates them independently", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.05, { momentum: 80 })
    ];
    const spy = new Map([["2026-06-10", 0.02]]);
    const [pt] = buildEquityCurve(observations, DEFAULT_SCORING_WEIGHTS, spy, 1);
    expect(pt.benchmarkReturn).toBeCloseTo(0.02, 8);
    expect(pt.benchmarkCumulativeReturn).toBeCloseTo(0.02, 8);
  });

  it("leaves benchmark null for dates with no SPY data", () => {
    const observations: FactorObservation[] = [obs("2026-06-10", "A", 0.05, { momentum: 80 })];
    const [pt] = buildEquityCurve(observations, DEFAULT_SCORING_WEIGHTS, new Map(), 1);
    expect(pt.benchmarkReturn).toBeNull();
    expect(pt.benchmarkCumulativeReturn).toBeNull();
  });

  it("returns an empty curve for empty observations", () => {
    expect(buildEquityCurve([], DEFAULT_SCORING_WEIGHTS, new Map())).toHaveLength(0);
  });
});

describe("computePerFactorIC", () => {
  it("is an alias for computeFactorICs — returns same output", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 20 }),
      obs("2026-06-10", "CCC", 0.03, { momentum: 30 })
    ];
    expect(computePerFactorIC(observations)).toEqual(computeFactorICs(observations));
  });

  it("empty rows → all factors have ic=0 and n=0", () => {
    const result = computePerFactorIC([]);
    expect(result).toHaveLength(MARKET_FACTORS.length);
    for (const entry of result) {
      expect(entry.ic).toBe(0);
      expect(entry.n).toBe(0);
    }
  });

  it("monotone signal → IC ≈ +1 for that factor", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { liquidity: 10 }),
      obs("2026-06-10", "B", 0.02, { liquidity: 20 }),
      obs("2026-06-10", "C", 0.03, { liquidity: 30 }),
      obs("2026-06-10", "D", 0.04, { liquidity: 40 })
    ];
    const result = computePerFactorIC(observations);
    const liq = result.find((e) => e.factor === "liquidity")!;
    expect(liq.ic).toBeCloseTo(1, 10);
    expect(liq.n).toBe(1);
  });
});

describe("deriveWeightsFromIC", () => {
  it("empty rows (no observations) → all default weights", () => {
    const perFactorIC = computePerFactorIC([]);
    const weights = deriveWeightsFromIC(perFactorIC);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it("negative IC → that factor receives its DEFAULT weight (not zeroed out)", () => {
    // Build factor ICs: all zero except momentum which is negative.
    // n=25 is above minN=20 for all, so they qualify (but their ICs are 0 or negative).
    const perFactorIC = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 25 }));
    perFactorIC.find((e) => e.factor === "momentum")!.ic = -0.5;

    // Every factor has ic <= 0 → no positives → full fallback to defaults.
    const weights = deriveWeightsFromIC(perFactorIC);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it("below minN threshold → falls back to defaults even with positive IC", () => {
    // All factors have n=5, below default minN=20.
    const perFactorIC = MARKET_FACTORS.map((factor) => ({ factor, ic: 0.4, n: 5 }));
    const weights = deriveWeightsFromIC(perFactorIC);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it("mixed: qualified factors scale to DEFAULT weight sum; unqualified use default weight", () => {
    // Only momentum and liquidity clear minN=20 with positive IC.
    // Expected: momentum and liquidity together sum to DEFAULT weight sum; rest are defaults.
    const perFactorIC = MARKET_FACTORS.map((factor) => ({
      factor,
      ic: 0,
      n: factor === "momentum" || factor === "liquidity" ? 25 : 5 // others below minN
    }));
    perFactorIC.find((e) => e.factor === "momentum")!.ic = 0.3;
    perFactorIC.find((e) => e.factor === "liquidity")!.ic = 0.1;

    const weights = deriveWeightsFromIC(perFactorIC);

    // Factors below minN should retain DEFAULT weight.
    for (const factor of MARKET_FACTORS) {
      if (factor !== "momentum" && factor !== "liquidity") {
        expect(weights[factor]).toBe(DEFAULT_SCORING_WEIGHTS[factor]);
      }
    }

    // Qualified factors should be positive.
    expect(weights["momentum"]!).toBeGreaterThan(0);
    expect(weights["liquidity"]!).toBeGreaterThan(0);

    // Momentum should be proportionally larger than liquidity (IC ratio 3:1).
    expect(weights["momentum"]! / weights["liquidity"]!).toBeCloseTo(3, 5);
  });

  it("all factors qualify with positive IC — sum of weights matches DEFAULT sum", () => {
    const defaultSum = MARKET_FACTORS.reduce((s, f) => s + DEFAULT_SCORING_WEIGHTS[f], 0);
    const perFactorIC = MARKET_FACTORS.map((factor) => ({ factor, ic: 0.5, n: 30 }));
    const weights = deriveWeightsFromIC(perFactorIC);

    const qualifiedSum = MARKET_FACTORS.reduce((s, f) => s + (weights[f] ?? 0), 0);
    // All qualify, so total weight sum should equal DEFAULT sum.
    expect(qualifiedSum).toBeCloseTo(defaultSum, 5);
  });
});

// ── P1-2: purged & embargoed walk-forward split ─────────────────────────────────────────────────
describe("splitWalkForward — P1-2 purge (opt-in, default-off byte-identical)", () => {
  const seven: FactorObservation[] = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07"]
    .map((d) => obs(d, "A", 0.01, { momentum: 1 }));

  it("DEFAULT (no options): identical to the prior positional call — embargo only, no purge", () => {
    // 7 dates × 0.7 = cut at 4 → train = first 4 dates; embargo horizonDays=2 → test drops the first 2 test buckets.
    const legacy = splitWalkForward(seven, 0.7, 2);
    const withEmptyOpts = splitWalkForward(seven, 0.7, 2, {});
    expect(new Set(withEmptyOpts.train.map((o) => o.date))).toEqual(new Set(legacy.train.map((o) => o.date)));
    expect(new Set(withEmptyOpts.test.map((o) => o.date))).toEqual(new Set(legacy.test.map((o) => o.date)));
    // Train keeps the full first-4 prefix when purge is off.
    expect(new Set(legacy.train.map((o) => o.date))).toEqual(new Set(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]));
  });

  it("PURGE on: drops the last `horizonDays` train-date buckets (the boundary-straddling rows)", () => {
    const purged = splitWalkForward(seven, 0.7, 2, { purge: true });
    // cutIdx=4, purge 2 → train = first 2 dates only; the boundary rows (dates 3 & 4) are purged.
    expect(new Set(purged.train.map((o) => o.date))).toEqual(new Set(["2026-01-01", "2026-01-02"]));
    // Test side is unchanged by the purge (still embargoed): dates 7 (indices 6) after testCut=4+2=6.
    expect(new Set(purged.test.map((o) => o.date))).toEqual(new Set(["2026-01-07"]));
  });

  it("PURGE always keeps at least one train date even when horizonDays >= cutIdx", () => {
    const purged = splitWalkForward(seven, 0.7, 10, { purge: true });
    expect(purged.train.length).toBeGreaterThanOrEqual(1);
  });
});

// ── P2-4: IC-weight shrinkage toward the default prior ───────────────────────────────────────────
describe("deriveWeightsFromICs — P2-4 shrinkage (default λ=0 no-op)", () => {
  const spikyICs: FactorIC[] = MARKET_FACTORS.map((factor, i) => ({ factor, ic: i === 0 ? 1 : 0.0, n: 30 }));

  it("λ=0 (default) is byte-identical to the unshrunk vector", () => {
    const unshrunk = deriveWeightsFromICs(spikyICs);
    const zeroLambda = deriveWeightsFromICs(spikyICs, DEFAULT_SCORING_WEIGHTS, 0);
    expect(zeroLambda).toEqual(unshrunk);
    // A single high-IC factor gets ALL the weight without shrinkage.
    expect(unshrunk[MARKET_FACTORS[0]]).toBeCloseTo(1, 6);
  });

  it("λ>0 pulls the vector toward the default prior and still sums to 1", () => {
    const shrunk = deriveWeightsFromICs(spikyICs, DEFAULT_SCORING_WEIGHTS, 0.5);
    // The spiked factor is damped below its unshrunk 1.0.
    expect(shrunk[MARKET_FACTORS[0]]).toBeLessThan(1);
    expect(shrunk[MARKET_FACTORS[0]]).toBeGreaterThan(0.5);
    // Other factors gain some prior mass (were 0 unshrunk).
    expect(shrunk[MARKET_FACTORS[1]]).toBeGreaterThan(0);
    const sum = MARKET_FACTORS.reduce((s, f) => s + shrunk[f], 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("λ=1 equals the unshrunk vector (all weight on the IC estimate)", () => {
    expect(deriveWeightsFromICs(spikyICs, DEFAULT_SCORING_WEIGHTS, 1)).toEqual(deriveWeightsFromICs(spikyICs));
  });
});

// ── P2-5: max-drawdown helper ────────────────────────────────────────────────────────────────────
describe("maxDrawdownOfCurve — P2-5", () => {
  const pt = (cumulativeReturn: number): EquityCurvePoint => ({
    date: "2026-01-01", nNames: 1, periodReturn: 0, benchmarkReturn: null, cumulativeReturn, benchmarkCumulativeReturn: null
  });
  it("0 for an empty or monotonically-rising curve", () => {
    expect(maxDrawdownOfCurve([])).toBe(0);
    expect(maxDrawdownOfCurve([pt(0), pt(0.1), pt(0.2)])).toBe(0);
  });
  it("captures the deepest peak-to-trough decline as a %", () => {
    // Peak equity 1.2 (cum +0.2), trough 0.9 (cum −0.1) → dd = (1.2−0.9)/1.2 = 0.25 → 25%.
    expect(maxDrawdownOfCurve([pt(0), pt(0.2), pt(-0.1), pt(0.05)])).toBeCloseTo(25, 6);
  });
});

// ── P1-4a: HARD look-ahead invariant (CI-failing on leakage) ─────────────────────────────────────
// 2026-01-05 is a Monday with no US market holiday before 2026-01-12, so 5 TRADING days lands on
// Mon 2026-01-12 (Tue/Wed/Thu/Fri/Mon) — not the calendar-day "Sat 2026-01-10" this test asserted
// before the trading-day-horizon fix (see docs/rollouts/2026-07-04-w1-learning-loops.md).
describe("isPointInTimeForwardExit — P1-4a leakage certification", () => {
  it("a same-day exit is REJECTED as look-ahead", () => {
    expect(isPointInTimeForwardExit("2026-01-05", 5, "2026-01-05")).toBe(false);
  });
  it("an exit before the horizon target is REJECTED", () => {
    // horizon 5 trading days → target 2026-01-12; an exit at 2026-01-08 is too early.
    expect(isPointInTimeForwardExit("2026-01-05", 5, "2026-01-08")).toBe(false);
  });
  it("an exit at/after the horizon target AND strictly after the snapshot is ACCEPTED", () => {
    expect(isPointInTimeForwardExit("2026-01-05", 5, "2026-01-12")).toBe(true);
    expect(isPointInTimeForwardExit("2026-01-05", 5, "2026-01-13")).toBe(true);
  });
});

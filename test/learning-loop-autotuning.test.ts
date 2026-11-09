// Workstream B — learning-loop auto-tuning. Pure-helper tests (no DB / network) covering the parts of
// items 2, 3, 4, 6, and 7 that live in side-effect-free functions. DB-backed integration tests (items 1,
// 6-sizing, 8) live in learning-loop-autotuning-db.test.ts.
import { describe, expect, it } from "vitest";
import {
  applyMissedOpportunityNudge,
  summarizeMissedOpportunities,
  type MissedOpportunityInput
} from "../src/lib/strategy-tuning";
import { calibratedConviction, confidenceBandOf, type ConfidenceCalibrationStat } from "../src/lib/performance";
import { congressGateMultiplier, type CongressScoreVerdictRead } from "../src/lib/congress-score-gate";
import { hasNotableWebSignal, outlierInterestScore } from "../src/lib/market";
import { computePerRegimeFactorICs, type FactorObservation } from "../src/lib/backtest";
import type { MarketFactor, ScoringWeights } from "../src/lib/types";

const WEIGHTS: ScoringWeights = {
  liquidity: 1, momentum: 1, value: 1, quality: 1, volatility: 1, sentiment: 1, positioning: 1, diversification: 1
};

// ── Item 4: recurringFactor >= 5 + SPY-relative winner test ────────────────────────────────────
describe("summarizeMissedOpportunities — item 4 hardening", () => {
  it("DEFAULT (flag off): winner = returnPct>0, recurring at >=2 (byte-identical to today)", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "A", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "B", returnPct: 8, dominantFactor: "momentum" },
      { symbol: "C", returnPct: 3, dominantFactor: "value" }
    ];
    const s = summarizeMissedOpportunities(rows);
    expect(s.count).toBe(3);
    expect(s.recurringFactor).toBe("momentum");
    expect(s.recurringFactorCount).toBe(2);
  });

  it("benchmark-relative: a name that beat 0 but LAGGED SPY no longer counts as a winner", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "A", returnPct: 4, benchmarkReturnPct: 6, dominantFactor: "momentum" }, // lagged SPY → excluded
      { symbol: "B", returnPct: 9, benchmarkReturnPct: 6, dominantFactor: "momentum" }, // beat SPY
      { symbol: "C", returnPct: 3, dominantFactor: "value" } // no benchmark → excluded in benchmark mode
    ];
    const s = summarizeMissedOpportunities(rows, { benchmarkRelative: true, minRecurringCount: 5 });
    expect(s.count).toBe(1); // only B beat the benchmark
    expect(s.items.map((i) => i.symbol)).toEqual(["B"]);
  });

  it("benchmark-relative recurring gate requires >= minRecurringCount (5) benchmark-beaters", () => {
    const beaters = (n: number, factor: MarketFactor): MissedOpportunityInput[] =>
      Array.from({ length: n }, (_, i) => ({ symbol: `${factor}${i}`, returnPct: 10, benchmarkReturnPct: 2, dominantFactor: factor }));
    // 4 momentum beaters — below the >=5 bar → no recurring factor flagged.
    const four = summarizeMissedOpportunities(beaters(4, "momentum"), { benchmarkRelative: true, minRecurringCount: 5 });
    expect(four.count).toBe(4);
    expect(four.recurringFactor).toBeUndefined();
    // 5 momentum beaters — meets the bar.
    const five = summarizeMissedOpportunities(beaters(5, "momentum"), { benchmarkRelative: true, minRecurringCount: 5 });
    expect(five.recurringFactor).toBe("momentum");
    expect(five.recurringFactorCount).toBe(5);
  });
});

// ── Item 3: transient missed-opportunity nudge into scan weights ────────────────────────────────
describe("applyMissedOpportunityNudge — item 3", () => {
  it("bumps a recognized recurring factor's weight by the clamped step", () => {
    const summary = summarizeMissedOpportunities([
      { symbol: "A", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "B", returnPct: 8, dominantFactor: "momentum" }
    ]);
    const res = applyMissedOpportunityNudge(WEIGHTS, summary);
    expect(res.nudgedFactor).toBe("momentum");
    expect(res.weights.momentum).toBeCloseTo(1.05, 5);
    // untouched factors are unchanged (weights not mutated in place)
    expect(res.weights.value).toBe(1);
    expect(WEIGHTS.momentum).toBe(1);
    expect(res.note).toContain("momentum");
  });

  it("returns weights UNCHANGED when there is no recurring factor", () => {
    const summary = summarizeMissedOpportunities([{ symbol: "A", returnPct: 10, dominantFactor: "momentum" }]);
    const res = applyMissedOpportunityNudge(WEIGHTS, summary);
    expect(res.nudgedFactor).toBeUndefined();
    expect(res.weights).toEqual(WEIGHTS);
  });

  it("ignores an unrecognized dominant factor (not a scoring factor)", () => {
    const summary = { items: [], count: 3, recurringFactor: "notAFactor", recurringFactorCount: 3 };
    const res = applyMissedOpportunityNudge(WEIGHTS, summary);
    expect(res.nudgedFactor).toBeUndefined();
    expect(res.weights).toEqual(WEIGHTS);
  });
});

// ── Item 6: confidence-calibration conviction remap (pure part) ─────────────────────────────────
describe("calibratedConviction — item 6", () => {
  const calibration: ConfidenceCalibrationStat[] = [
    { band: "85-100 (high)", trades: 10, winRate: 40, shrunkWinRate: 42, avgReturnPct: -1 },
    { band: "50-69", trades: 2, winRate: 100, shrunkWinRate: 80, avgReturnPct: 5 }
  ];
  it("shrinks an over-confident, poorly-calibrated high band DOWN toward realized", () => {
    // raw 0.90; band realized 0.42; blended → (0.90+0.42)/2 = 0.66
    expect(calibratedConviction(90, calibration)).toBeCloseTo(0.66, 4);
  });
  it("never INFLATES: a band whose realized win rate exceeds raw is left unchanged", () => {
    // A 60 → band "50-69" realized 0.80 >= raw 0.60 → unchanged 0.60 (but that band also has <5 trades)
    expect(calibratedConviction(60, calibration)).toBeCloseTo(0.6, 4);
  });
  it("ignores a band with too few trades (min 5) and returns raw", () => {
    expect(calibratedConviction(55, calibration)).toBeCloseTo(0.55, 4); // 50-69 band has 2 trades
  });
  it("returns raw when no calibration data for the band", () => {
    expect(calibratedConviction(75, calibration)).toBeCloseTo(0.75, 4); // no 70-84 band
  });
  it("band boundaries", () => {
    expect(confidenceBandOf(85)).toBe("85-100 (high)");
    expect(confidenceBandOf(70)).toBe("70-84");
    expect(confidenceBandOf(50)).toBe("50-69");
    expect(confidenceBandOf(49)).toBe("1-49 (low)");
  });

  it("ISOTONIC clamp: a low-N-adjacent inverted mid band can't lift a mid call above a high call", () => {
    // Realized rates that VIOLATE monotonicity: mid band (70-84) realized HIGHER than the high band.
    // All bands are well-sampled (>=5 trades). Pool-adjacent-violators averages the violating pair, so the
    // isotonic mid <= isotonic high, and neither remap inverts the raw ordering.
    const cal: ConfidenceCalibrationStat[] = [
      { band: "85-100 (high)", trades: 10, winRate: 40, shrunkWinRate: 40, avgReturnPct: 0 }, // high realized LOW
      { band: "70-84", trades: 10, winRate: 60, shrunkWinRate: 60, avgReturnPct: 0 } // mid realized HIGHER (violation)
    ];
    const high = calibratedConviction(90, cal); // raw 0.90
    const mid = calibratedConviction(75, cal); // raw 0.75
    // Both bands pool to (40+60)/2 = 50% realized → high blends (0.9+0.5)/2=0.70, mid blends (0.75+0.5)/2=0.625.
    expect(high).toBeCloseTo(0.7, 4);
    expect(mid).toBeCloseTo(0.625, 4);
    // Monotonic preserved: the higher-confidence call is still sized >= the mid call.
    expect(high).toBeGreaterThanOrEqual(mid);
  });
});

// ── Item 2: congress go/no-go gate multiplier (pure) ───────────────────────────────────────────
describe("congressGateMultiplier — item 2 (three-way verdict)", () => {
  const pass: CongressScoreVerdictRead = { verdict: "PASS", pass: true, computedAt: "", reasons: [], stats: {} as never, stale: false };
  const failSig: CongressScoreVerdictRead = { verdict: "FAIL_SIGNIFICANCE", pass: false, computedAt: "", reasons: ["rank IC t-stat is below 2"], stats: {} as never, stale: false };
  const insufficient: CongressScoreVerdictRead = { verdict: "INSUFFICIENT", pass: false, computedAt: "", reasons: ["insufficient observations (10 < 500)"], stats: {} as never, stale: false };
  const staleFailSig: CongressScoreVerdictRead = { ...failSig, stale: true };
  it("gating OFF → always 1 (default byte-identical)", () => {
    expect(congressGateMultiplier(failSig, false)).toBe(1);
    expect(congressGateMultiplier(undefined, false)).toBe(1);
  });
  it("gating ON, fresh FAIL_SIGNIFICANCE → 0 (down-weight)", () => {
    expect(congressGateMultiplier(failSig, true)).toBe(0);
  });
  it("gating ON, fresh INSUFFICIENT → 1 (neutral — data-poverty is NOT a kill-switch)", () => {
    expect(congressGateMultiplier(insufficient, true)).toBe(1);
  });
  it("gating ON, PASS → 1", () => {
    expect(congressGateMultiplier(pass, true)).toBe(1);
  });
  it("gating ON but verdict absent or STALE → fail-open (1)", () => {
    expect(congressGateMultiplier(undefined, true)).toBe(1);
    expect(congressGateMultiplier(staleFailSig, true)).toBe(1);
  });
});

describe("classifyCongressVerdict — item 2", () => {
  it("PASS when the eval passed", async () => {
    const { classifyCongressVerdict } = await import("../src/lib/congress-score-gate");
    expect(classifyCongressVerdict(true, [])).toBe("PASS");
  });
  it("INSUFFICIENT when any failure reason is a data-insufficiency marker", async () => {
    const { classifyCongressVerdict } = await import("../src/lib/congress-score-gate");
    expect(classifyCongressVerdict(false, ["insufficient dates (10 < 60)", "rank IC t-stat is below 2"])).toBe("INSUFFICIENT");
    expect(classifyCongressVerdict(false, ["benchmarkReturn is required for excess-return evaluation"])).toBe("INSUFFICIENT");
  });
  it("FAIL_SIGNIFICANCE when failures are significance-only on adequate data", async () => {
    const { classifyCongressVerdict } = await import("../src/lib/congress-score-gate");
    expect(classifyCongressVerdict(false, ["rank IC t-stat is below 2", "placebo IC is not lower than real IC"])).toBe("FAIL_SIGNIFICANCE");
  });
});

describe("outlierInterestScore congress gating — item 2 integration", () => {
  const congressSig = { congress: { netSignal: 3, buyCount: 3 } as never, bulletins: [] };
  it("multiplier 1 (default) leaves the congress outlier score intact", () => {
    expect(outlierInterestScore(congressSig, 1)).toBeGreaterThan(0);
    expect(hasNotableWebSignal(congressSig, 1)).toBe(true);
  });
  it("multiplier 0 (no-go verdict) zeroes the congress term so it no longer lifts a name in", () => {
    expect(outlierInterestScore(congressSig, 0)).toBe(0);
    expect(hasNotableWebSignal(congressSig, 0)).toBe(false);
  });
  it("multiplier 0 does NOT zero a non-congress signal (short pressure still promotes)", () => {
    const shortSig = { shortVolumeRatio: 70, bulletins: [] } as never;
    expect(outlierInterestScore(shortSig, 0)).toBeGreaterThan(0);
  });
});

// ── Item 7: per-regime factor IC report (pure) ─────────────────────────────────────────────────
describe("computePerRegimeFactorICs — item 7 (report only)", () => {
  const mk = (regime: string | undefined, date: string, symbol: string, momentum: number, forwardReturn: number): FactorObservation => ({
    date,
    symbol,
    forwardReturn,
    ...(regime ? { regime } : {}),
    subScores: { liquidity: 0, momentum, value: 0, quality: 0, volatility: 0, sentiment: 0, positioning: 0, diversification: 0 }
  });
  it("buckets by regime and flags sufficiency by distinct dates", () => {
    const obs: FactorObservation[] = [
      mk("Bull", "2026-01-01", "A", 90, 0.1),
      mk("Bull", "2026-01-01", "B", 10, -0.1),
      mk("Bear", "2026-02-01", "A", 90, -0.2),
      mk("Bear", "2026-02-01", "B", 10, 0.2),
      mk(undefined, "2026-03-01", "C", 50, 0.0)
    ];
    const report = computePerRegimeFactorICs(obs, 8);
    const regimes = report.map((r) => r.regime).sort();
    expect(regimes).toEqual(["Bear", "Bull", "Unspecified"]);
    // Only 1 distinct date per regime here → far below minDates(8) → not sufficient (correct — too thin).
    expect(report.every((r) => r.sufficient === false)).toBe(true);
    const bull = report.find((r) => r.regime === "Bull");
    expect(bull?.observations).toBe(2);
  });
});

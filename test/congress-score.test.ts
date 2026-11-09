import { describe, expect, it } from "vitest";
import { congressLongScore, scoreCongressSignal } from "../src/lib/congress-score";
import { congressScoreObservationsFromExportRows, evaluateCongressScore, type CongressScoreObservation } from "../src/lib/congress-score-eval";

describe("scoreCongressSignal", () => {
  it("combines conviction, cluster breadth, member skill, flow, recency, and confidence", () => {
    const result = scoreCongressSignal(
      {
        congress: {
          netSignal: 3,
          buyCount: 4,
          sellCount: 1,
          buyMembers: ["A", "B", "C"],
          sellMembers: ["D"],
          windowDays: 90,
          lastDisclosedAt: "2026-06-20",
          bulletin: "Recent congressional buying"
        },
        congressAnalytics: {
          netFlowUsd: 1_000_000,
          memberCount: 4,
          cluster: true,
          clusterMemberCount: 4,
          topMemberScore: 80,
          convictionScore: 72,
          convictionDirection: "BUY",
          tradeCount: 7,
          conflictCount: 1
        }
      },
      Date.parse("2026-06-27T00:00:00Z")
    );

    expect(result.direction).toBe("BUY");
    expect(result.score).toBeGreaterThan(60);
    expect(result.signedScore).toBe(result.score);
    expect(result.confidence).toBe(1);
    expect(result.components.memberSkill).toBe(80);
    expect(result.provenance.sourced).toContain("congress.trade convictionScore");
  });

  it("caps high raw conviction when the signal is thin", () => {
    const result = scoreCongressSignal({
      congressAnalytics: {
        netFlowUsd: 1_000_000_000,
        memberCount: 1,
        topMemberScore: 100,
        convictionScore: 100,
        convictionDirection: "BUY"
      }
    });

    expect(result.direction).toBe("BUY");
    expect(result.confidence).toBe(0.4);
    expect(result.score).toBeLessThanOrEqual(58);
    expect(result.provenance.computed).toContain("confidence cap applied");
  });

  it("keeps bearish congressional evidence signed negative and out of long-only outlier scoring", () => {
    const input = { congressAnalytics: { netFlowUsd: -500_000, netSentiment: -0.8, convictionScore: 82, convictionDirection: "SELL" as const } };
    const result = scoreCongressSignal(input);
    expect(result.direction).toBe("SELL");
    expect(result.score).toBeGreaterThan(0);
    expect(result.signedScore).toBeLessThan(0);
    expect(congressLongScore(input)).toBe(0);
  });
});

describe("evaluateCongressScore", () => {
  it("reports positive rank IC, quantile spread, marginal IC, and placebo delta for a monotone signal", () => {
    const observations: CongressScoreObservation[] = [
      ...date("2026-01-02", "perfect"),
      ...date("2026-01-03", "mild-noise"),
      ...date("2026-01-04", "strong-noise")
    ];
    const result = evaluateCongressScore(observations, {
      quantiles: 2,
      minNamesPerDate: 3,
      minObservations: 12,
      minDates: 3,
      minTickers: 4,
      minTopBucketObservations: 6,
      placeboSeed: 1
    });
    expect(result.rankIC.meanIC).toBeGreaterThan(0.9);
    expect(result.rankIC.tStat).toBeGreaterThan(2);
    expect(result.marginalIC?.meanIC).toBeGreaterThan(0.9);
    expect(result.topMinusBottomReturn).toBeGreaterThan(0);
    expect(result.placeboDeltaIC).toBeGreaterThan(0);
    expect(result.goNoGo.pass).toBe(true);
  });

  it("does not let identical overlapping ICs pass via an infinite t-stat", () => {
    const observations: CongressScoreObservation[] = [
      ...date("2026-01-02", "perfect"),
      ...date("2026-01-03", "perfect"),
      ...date("2026-01-04", "perfect")
    ];
    const result = evaluateCongressScore(observations, {
      quantiles: 2,
      minNamesPerDate: 3,
      minObservations: 12,
      minDates: 3,
      minTickers: 4,
      minTopBucketObservations: 6,
      placeboSeed: 1
    });
    expect(result.rankIC.meanIC).toBeGreaterThan(0.9);
    expect(result.rankIC.tStat).toBe(0);
    expect(result.goNoGo.pass).toBe(false);
    expect(result.goNoGo.reasons).toContain("rank IC t-stat is below 2");
  });

  it("gates dates by rank-IC contributing dates, not sparse raw dates", () => {
    const observations: CongressScoreObservation[] = Array.from({ length: 60 }, (_, i) => ({
      date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
      symbol: `S${i}`,
      congressScore: 50,
      congressDirection: "BUY" as const,
      forwardReturn: 0.01,
      benchmarkReturn: 0
    }));
    observations.push(...date("2026-03-30", "mild-noise"));
    const result = evaluateCongressScore(observations, {
      quantiles: 2,
      minNamesPerDate: 3,
      minObservations: 1,
      minDates: 60,
      minTickers: 1,
      minTopBucketObservations: 1,
      placeboSeed: 1
    });
    expect(result.rawDates).toBeGreaterThan(1);
    expect(result.dates).toBe(1);
    expect(result.goNoGo.reasons).toContain("insufficient dates (1 < 60)");
  });

  it("fails the go/no-go gate when score does not predict forward returns", () => {
    const observations: CongressScoreObservation[] = [
      { date: "2026-01-02", symbol: "A", congressScore: 90, congressDirection: "BUY", forwardReturn: -0.03 },
      { date: "2026-01-02", symbol: "B", congressScore: 60, congressDirection: "BUY", forwardReturn: 0.0 },
      { date: "2026-01-02", symbol: "C", congressScore: 10, congressDirection: "BUY", forwardReturn: 0.04 }
    ];
    const result = evaluateCongressScore(observations, {
      quantiles: 3,
      minNamesPerDate: 3,
      minObservations: 3,
      minDates: 1,
      minTickers: 3,
      minTopBucketObservations: 1,
      requireBenchmarkReturn: false
    });
    expect(result.rankIC.meanIC).toBeLessThan(0);
    expect(result.goNoGo.pass).toBe(false);
    expect(result.goNoGo.reasons).toContain("rank IC is not positive");
  });

  // ── P2-3: signed/directional top-bucket gate (require the long leg's own edge, not just the spread) ──
  it("P2-3: a positive top-minus-bottom spread carried by the SHORT leg is BLOCKED when requireTopBucketPositive", () => {
    // 3 dates × 4 names/date. Score ranks names; TOP bucket names are slightly NEGATIVE while BOTTOM bucket
    // names are strongly negative — so the top-minus-bottom SPREAD is positive but the long (top) leg loses.
    const build = (d: string) => [
      { date: d, symbol: `T1-${d}`, congressScore: 90, congressDirection: "BUY" as const, forwardReturn: -0.005, benchmarkReturn: 0 },
      { date: d, symbol: `T2-${d}`, congressScore: 80, congressDirection: "BUY" as const, forwardReturn: -0.004, benchmarkReturn: 0 },
      { date: d, symbol: `B1-${d}`, congressScore: 20, congressDirection: "BUY" as const, forwardReturn: -0.05, benchmarkReturn: 0 },
      { date: d, symbol: `B2-${d}`, congressScore: 10, congressDirection: "BUY" as const, forwardReturn: -0.06, benchmarkReturn: 0 }
    ];
    const observations: CongressScoreObservation[] = [...build("2026-01-02"), ...build("2026-01-03"), ...build("2026-01-04")];
    const opts = { quantiles: 2, minNamesPerDate: 4, minObservations: 3, minDates: 1, minTickers: 3, minTopBucketObservations: 1, requireBenchmarkReturn: false };

    // Without the flag: the top-minus-bottom spread is positive (top ~−0.0045 vs bottom ~−0.055).
    const off = evaluateCongressScore(observations, opts);
    expect(off.topMinusBottomReturn).toBeGreaterThan(0);
    expect(off.goNoGo.reasons).not.toContain(off.goNoGo.reasons.find((r) => r.startsWith("top-bucket long-leg")) ?? "__none__");

    // With the flag: the TOP bucket's own excess return is negative → a new blocking reason appears.
    const on = evaluateCongressScore(observations, { ...opts, requireTopBucketPositive: true });
    expect(on.goNoGo.reasons.some((r) => r.startsWith("top-bucket long-leg excess return is not positive"))).toBe(true);
    expect(on.goNoGo.pass).toBe(false);
  });

  it("P2-3: a genuinely long-positive top bucket PASSES the requireTopBucketPositive check", () => {
    const build = (d: string) => [
      { date: d, symbol: `T1-${d}`, congressScore: 90, congressDirection: "BUY" as const, forwardReturn: 0.05, benchmarkReturn: 0 },
      { date: d, symbol: `T2-${d}`, congressScore: 80, congressDirection: "BUY" as const, forwardReturn: 0.04, benchmarkReturn: 0 },
      { date: d, symbol: `B1-${d}`, congressScore: 20, congressDirection: "BUY" as const, forwardReturn: 0.0, benchmarkReturn: 0 },
      { date: d, symbol: `B2-${d}`, congressScore: 10, congressDirection: "BUY" as const, forwardReturn: -0.01, benchmarkReturn: 0 }
    ];
    const observations: CongressScoreObservation[] = [...build("2026-01-02"), ...build("2026-01-03"), ...build("2026-01-04")];
    const on = evaluateCongressScore(observations, { quantiles: 2, minNamesPerDate: 4, minObservations: 3, minDates: 1, minTickers: 3, minTopBucketObservations: 1, requireBenchmarkReturn: false, requireTopBucketPositive: true });
    // The top bucket's own excess return is clearly positive → the P2-3 reason must NOT be present.
    expect(on.goNoGo.reasons.some((r) => r.startsWith("top-bucket long-leg excess return is not positive"))).toBe(false);
  });
});

describe("congressScoreObservationsFromExportRows", () => {
  it("maps App A PIT rows with nested labels and baselines into evaluator observations", () => {
    const rows = congressScoreObservationsFromExportRows([
      {
        date: "2025-12-15",
        asOf: "2026-01-02T00:00:00.000Z",
        dataCutoffAt: "2026-01-02T00:00:00.000Z",
        ticker: "NVDA",
        congressScore: 83,
        signedScore: 83,
        direction: "BUY",
        forwardReturn: 999,
        rawInputs: { conservativeLabelEntryDate: "2026-01-03" },
        labels: {
          horizons: [
            { horizon: "21d", days: 21, entryDate: "2026-01-03", assetReturn: 0.05, spxReturn: 0.01 },
            { horizon: "63d", days: 63, entryDate: "2026-01-03", assetReturn: 0.12, spxReturn: 0.03 }
          ]
        },
        baselines: { appBPreCongressScanScore: 71 }
      }
    ], { horizonDays: 63 });

    expect(rows).toEqual([
      {
        date: "2026-01-02T00:00:00.000Z",
        symbol: "NVDA",
        congressScore: 83,
        congressSignedScore: 83,
        congressDirection: "BUY",
        forwardReturn: 0.12,
        benchmarkReturn: 0.03,
        baselineScore: 71,
        returnKind: "raw_with_benchmark"
      }
    ]);
  });

  it("rejects PIT rows whose selected horizon label is missing or not actionable after availability", () => {
    const rows = congressScoreObservationsFromExportRows([
      {
        asOf: "2026-01-02T00:00:00.000Z",
        dataCutoffAt: "2026-01-02T00:00:00.000Z",
        ticker: "NVDA",
        congressScore: 83,
        signedScore: 83,
        direction: "BUY",
        labels: {
          horizons: [
            { horizon: "21d", days: 21, entryDate: "2026-01-03", assetReturn: 0.05, spxReturn: 0.01 },
            { horizon: "63d", days: 63, entryDate: "2026-01-01", assetReturn: 0.12, spxReturn: 0.03 }
          ]
        }
      }
    ], { horizonDays: 63 });

    expect(rows).toEqual([]);
  });

  it("rejects PIT rows with future member skill vintages", () => {
    const rows = congressScoreObservationsFromExportRows([
      {
        asOf: "2026-01-02T00:00:00.000Z",
        dataCutoffAt: "2026-01-02T00:00:00.000Z",
        ticker: "NVDA",
        congressScore: 83,
        signedScore: 83,
        direction: "BUY",
        memberSkill: { skillScore: 75, skillAsOf: "2026-01-02T00:00:00.000Z", skillScoredThrough: "2026-02-01T00:00:00.000Z" },
        labels: {
          horizons: [
            { horizon: "63d", days: 63, entryDate: "2026-01-03", assetReturn: 0.12, spxReturn: 0.03 }
          ]
        }
      }
    ], { horizonDays: 63 });

    expect(rows).toEqual([]);
  });

  it("rejects PIT rows that App A marks as not historically validation-ready", () => {
    const rows = congressScoreObservationsFromExportRows([
      {
        asOf: "2026-01-02T00:00:00.000Z",
        dataCutoffAt: "2026-01-02T00:00:00.000Z",
        ticker: "NVDA",
        congressScore: 83,
        signedScore: 83,
        direction: "BUY",
        pitValidity: {
          scoreInputsPitSafe: true,
          historicalValidationReady: false,
          blockers: ["missing true PIT metadata vintages"]
        },
        labels: {
          horizons: [
            { horizon: "63d", days: 63, entryDate: "2026-01-03", assetReturn: 0.12, spxReturn: 0.03 }
          ]
        }
      }
    ], { horizonDays: 63 });

    expect(rows).toEqual([]);
  });

  it("maps top-level preCongressScore for flat exports", () => {
    const rows = congressScoreObservationsFromExportRows([
      { date: "2026-01-02", symbol: "MSFT", congressScore: 70, signedScore: 70, forwardReturn: 0.04, benchmarkReturn: 0.01, preCongressScore: 65 }
    ]);

    expect(rows[0]?.baselineScore).toBe(65);
  });

  it("treats explicit excess-return rows as benchmark-covered", () => {
    const rows = congressScoreObservationsFromExportRows([
      { date: "2026-01-02", symbol: "AAA", congressScore: 90, signedScore: 90, forwardExcessReturn: 0.06, preCongressScore: 50 },
      { date: "2026-01-02", symbol: "BBB", congressScore: 50, signedScore: 50, forwardExcessReturn: 0.01, preCongressScore: 50 },
      { date: "2026-01-02", symbol: "CCC", congressScore: 20, signedScore: 20, forwardExcessReturn: -0.02, preCongressScore: 50 }
    ]);
    const result = evaluateCongressScore(rows, {
      quantiles: 3,
      minNamesPerDate: 3,
      minObservations: 3,
      minDates: 1,
      minTickers: 3,
      minTopBucketObservations: 1
    });

    expect(rows.every((row) => row.returnKind === "excess")).toBe(true);
    expect(result.benchmarkCoveragePct).toBe(1);
    expect(result.goNoGo.reasons).not.toContain("benchmarkReturn is required for excess-return evaluation");
  });

  it("does not use contaminated scanScore or marketScore aliases as marginal baselines", () => {
    const rows = congressScoreObservationsFromExportRows([
      { date: "2026-01-02", symbol: "MSFT", congressScore: 70, signedScore: 70, forwardReturn: 0.04, benchmarkReturn: 0.01, scanScore: 99, marketScore: 88, preCongressScore: 65 },
      { date: "2026-01-02", symbol: "AAPL", congressScore: 60, signedScore: 60, forwardReturn: 0.03, benchmarkReturn: 0.01, scanScore: 1, marketScore: 2 }
    ]);

    expect(rows[0]?.baselineScore).toBe(65);
    expect(rows[1]?.baselineScore).toBeUndefined();
  });

  it("drops unsigned exports instead of assuming positive direction", () => {
    const rows = congressScoreObservationsFromExportRows([
      { date: "2026-01-02", symbol: "MSFT", congressScore: 70, forwardReturn: 0.04, benchmarkReturn: 0.01 }
    ]);

    expect(rows).toEqual([]);
  });
});

function date(dateValue: string, variant: "perfect" | "mild-noise" | "strong-noise"): CongressScoreObservation[] {
  const base: CongressScoreObservation[] = [
    { date: dateValue, symbol: "AAA", congressScore: 90, congressDirection: "BUY", forwardReturn: 0.09, benchmarkReturn: 0.01, baselineScore: 50 },
    { date: dateValue, symbol: "BBB", congressScore: 70, congressDirection: "BUY", forwardReturn: 0.05, benchmarkReturn: 0.01, baselineScore: 50 },
    { date: dateValue, symbol: "CCC", congressScore: 30, congressDirection: "NEUTRAL", forwardReturn: 0.0, benchmarkReturn: 0.01, baselineScore: 50 },
    { date: dateValue, symbol: "DDD", congressScore: 80, congressSignedScore: -80, congressDirection: "SELL", forwardReturn: -0.04, benchmarkReturn: 0.01, baselineScore: 50 }
  ];
  if (variant === "mild-noise") base[2] = { ...base[2], forwardReturn: -0.03 };
  if (variant === "strong-noise") {
    base[2] = { ...base[2], forwardReturn: -0.05 };
    base[3] = { ...base[3], forwardReturn: -0.01 };
  }
  return base;
}

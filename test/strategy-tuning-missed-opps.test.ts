import { describe, expect, it } from "vitest";
import { summarizeMissedOpportunities, type MissedOpportunityInput } from "../src/lib/strategy-tuning";

describe("summarizeMissedOpportunities", () => {
  it("keeps only positive-return skipped names and shapes the items", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "AAA", returnPct: 12.5, score: 88, sector: "Tech", regime: "expansion", dominantFactor: "momentum", ageDays: 6 },
      { symbol: "BBB", returnPct: -3.2, dominantFactor: "value" }, // negative — excluded
      { symbol: "CCC", returnPct: 0, dominantFactor: "value" }, // zero — excluded
      { symbol: "DDD", returnPct: 4.1, dominantFactor: "momentum" }
    ];
    const summary = summarizeMissedOpportunities(rows);
    expect(summary.count).toBe(2);
    expect(summary.items.map((i) => i.symbol)).toEqual(["AAA", "DDD"]);
    expect(summary.items[0]).toMatchObject({ symbol: "AAA", returnPct: 12.5, dominantFactor: "momentum", sector: "Tech" });
    // optional fields are omitted, not set to undefined
    expect(Object.prototype.hasOwnProperty.call(summary.items[1], "sector")).toBe(false);
  });

  it("flags a recurring dominant factor when it appears in >= 2 missed winners", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "AAA", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "BBB", returnPct: 8, dominantFactor: "momentum" },
      { symbol: "CCC", returnPct: 5, dominantFactor: "value" }
    ];
    const summary = summarizeMissedOpportunities(rows);
    expect(summary.recurringFactor).toBe("momentum");
    expect(summary.recurringFactorCount).toBe(2);
  });

  it("does not flag a recurring factor when none repeats", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "AAA", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "BBB", returnPct: 8, dominantFactor: "value" }
    ];
    const summary = summarizeMissedOpportunities(rows);
    expect(summary.recurringFactor).toBeUndefined();
    expect(summary.recurringFactorCount).toBeUndefined();
  });

  it("caps the item list at the limit but still counts every winner", () => {
    const rows: MissedOpportunityInput[] = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, returnPct: 12 - i * 0.5 }));
    const summary = summarizeMissedOpportunities(rows, 8);
    expect(summary.items).toHaveLength(8);
    expect(summary.count).toBe(12);
  });

  it("returns an empty summary when there are no missed winners", () => {
    const summary = summarizeMissedOpportunities([{ symbol: "AAA", returnPct: -5 }]);
    expect(summary.count).toBe(0);
    expect(summary.items).toEqual([]);
    expect(summary.recurringFactor).toBeUndefined();
  });
});

// ── P2-1 / P2-2: missed-opportunity HIT-RATE gate (track skipped LOSERS, benchmark parity) ────────
describe("summarizeMissedOpportunities — P2-1 hit-rate gate (opt-in)", () => {
  it("DEFAULT (requireHitRate off) is byte-identical to the winners-only count", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "A", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "B", returnPct: 8, dominantFactor: "momentum" },
      { symbol: "C", returnPct: -4, dominantFactor: "momentum" }
    ];
    const s = summarizeMissedOpportunities(rows, { minRecurringCount: 2 });
    // Winners-only count: momentum recurs across 2 WINNERS regardless of the loser.
    expect(s.recurringFactor).toBe("momentum");
    expect(s.recurringFactorCount).toBe(2);
    expect(s.baseHitRate).toBeUndefined();
  });

  it("with requireHitRate: a factor that only RECURS AMONG WINNERS but LOSES on balance is NOT flagged", () => {
    // 'momentum' appears in 2 winners but 8 losers → 20% hit rate, well below the base rate → not flagged.
    const rows: MissedOpportunityInput[] = [
      ...Array.from({ length: 2 }, (_, i) => ({ symbol: `MW${i}`, returnPct: 10, dominantFactor: "momentum" as const })),
      ...Array.from({ length: 8 }, (_, i) => ({ symbol: `ML${i}`, returnPct: -6, dominantFactor: "momentum" as const })),
      // 'value' is a genuine winner: 4 winners / 5 total = 80% hit rate.
      ...Array.from({ length: 4 }, (_, i) => ({ symbol: `VW${i}`, returnPct: 7, dominantFactor: "value" as const })),
      { symbol: "VL0", returnPct: -2, dominantFactor: "value" as const }
    ];
    const s = summarizeMissedOpportunities(rows, { requireHitRate: true, minRecurringCount: 2, minHitRateDenominator: 5 });
    // base rate = 6 winners / 15 total = 0.4. 'momentum' 20% < base → excluded; 'value' 80% >= base → flagged.
    expect(s.baseHitRate).toBeCloseTo(0.4, 3);
    expect(s.recurringFactor).toBe("value");
    expect(s.recurringFactorHitRate).toBeGreaterThanOrEqual(s.baseHitRate!);
  });

  it("with requireHitRate: a factor below the minimum denominator is not flagged even at 100% wins", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "Q0", returnPct: 5, dominantFactor: "quality" },
      { symbol: "Q1", returnPct: 6, dominantFactor: "quality" },
      // Filler losers so the base rate is meaningful.
      ...Array.from({ length: 6 }, (_, i) => ({ symbol: `F${i}`, returnPct: -3, dominantFactor: "sentiment" as const }))
    ];
    // quality has only 2 rows < minHitRateDenominator (5) → not trusted → not flagged.
    const s = summarizeMissedOpportunities(rows, { requireHitRate: true, minRecurringCount: 2, minHitRateDenominator: 5 });
    expect(s.recurringFactor).toBeUndefined();
  });

  it("P2-2: benchmark-relative classifies BOTH winners and losers net-of-benchmark", () => {
    const rows: MissedOpportunityInput[] = [
      // Beat SPY (winner): +9 vs +2.
      ...Array.from({ length: 5 }, (_, i) => ({ symbol: `W${i}`, returnPct: 9, benchmarkReturnPct: 2, dominantFactor: "momentum" as const })),
      // Rose but LAGGED SPY (net loser): +3 vs +6.
      ...Array.from({ length: 5 }, (_, i) => ({ symbol: `L${i}`, returnPct: 3, benchmarkReturnPct: 6, dominantFactor: "momentum" as const }))
    ];
    const s = summarizeMissedOpportunities(rows, { requireHitRate: true, benchmarkRelative: true, minRecurringCount: 2, minHitRateDenominator: 5 });
    // 5 of 10 momentum names beat SPY → 50% hit rate == base rate → flagged (shrunk ~0.5 >= 0.5).
    expect(s.baseHitRate).toBeCloseTo(0.5, 3);
    expect(s.recurringFactor).toBe("momentum");
  });
});

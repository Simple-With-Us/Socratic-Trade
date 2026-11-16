import { describe, expect, it } from "vitest";
import { stressScenario } from "../src/lib/stress-scenario";

describe("stressScenario", () => {
  it("computes shockPct deterministically from vix + shockSigmas", () => {
    const r = stressScenario({ positions: [], equity: 100_000, vix: 20, shockSigmas: 2 });
    // dailySigma = 20 / sqrt(252) / 100 = 0.012598...; shock = -2 * dailySigma = -0.025198... (~ -2.52%)
    expect(r).toBeDefined();
    expect(r!.shockPct).toBeCloseTo(-2.519763153394848, 6);
  });

  it("known book (long + short + beta mix) matches hand-computed impacts", () => {
    const r = stressScenario({
      positions: [
        { symbol: "AAPL", marketValue: 10_000, beta: 1.2 },
        { symbol: "SPY_SHORT", marketValue: -5_000, beta: 1.0 }
      ],
      equity: 100_000,
      vix: 20,
      shockSigmas: 2
    });
    expect(r).toBeDefined();
    // impact_AAPL = 1.2 * shockFraction * 10000; impact_SHORT = 1.0 * shockFraction * -5000
    expect(r!.bookImpactUsd).toBeCloseTo(-176.3834207376393, 4);
    expect(r!.bookImpactPctOfEquity).toBeCloseTo(-0.17638342073763932, 6);
    // No candidate supplied → withCandidate equals book impact exactly.
    expect(r!.withCandidateImpactUsd).toBe(r!.bookImpactUsd);
    expect(r!.candidateMarginalUsd).toBe(0);
  });

  it("sign correctness: a SHORT position (negative marketValue) gains under a down shock (hedge credit)", () => {
    const r = stressScenario({
      positions: [{ symbol: "SHORT1", marketValue: -10_000, beta: 1.0 }],
      equity: 50_000,
      vix: 20,
      shockSigmas: 2
    });
    expect(r).toBeDefined();
    // Down shock (negative fraction) * negative marketValue = positive impact.
    expect(r!.bookImpactUsd).toBeGreaterThan(0);
  });

  it("sign correctness: a SHORT candidate has a POSITIVE marginal impact under a down shock", () => {
    const r = stressScenario({
      positions: [{ symbol: "A", marketValue: 5_000, beta: 1.0 }],
      candidate: { symbol: "D", notional: 2_000, side: "short", beta: 1.1 },
      equity: 50_000,
      vix: 20,
      shockSigmas: 2
    });
    expect(r).toBeDefined();
    expect(r!.candidateMarginalUsd).toBeGreaterThan(0);
    expect(r!.candidateMarginalUsd).toBeCloseTo(55.43478937468666, 4);
  });

  it("sign correctness: a BUY (long) candidate has a NEGATIVE marginal impact under a down shock", () => {
    const r = stressScenario({
      positions: [],
      candidate: { symbol: "D", notional: 2_000, side: "buy", beta: 1.1 },
      equity: 50_000,
      vix: 20,
      shockSigmas: 2
    });
    expect(r).toBeDefined();
    expect(r!.candidateMarginalUsd).toBeLessThan(0);
  });

  it("sell/cover candidates contribute zero marginal impact (pre-trade OPENING receipt only)", () => {
    const r = stressScenario({
      positions: [{ symbol: "A", marketValue: 5_000, beta: 1.0 }],
      candidate: { symbol: "A", notional: 2_000, side: "sell", beta: 1.0 },
      equity: 50_000
    });
    expect(r).toBeDefined();
    expect(r!.candidateMarginalUsd).toBe(0);
    expect(r!.withCandidateImpactUsd).toBe(r!.bookImpactUsd);
  });

  it("missing beta falls back to 1.0 and is marked estimated when > half the book lacks one", () => {
    const r = stressScenario({
      positions: [
        { symbol: "A", marketValue: 5_000 }, // no beta
        { symbol: "B", marketValue: 5_000 }, // no beta
        { symbol: "C", marketValue: 5_000, beta: 1.5 }
      ],
      candidate: { symbol: "D", notional: 2_000, side: "short", beta: 1.1 },
      equity: 50_000,
      vix: 20,
      shockSigmas: 2
    });
    expect(r).toBeDefined();
    expect(r!.betaTotalCount).toBe(3);
    expect(r!.betaEstimatedCount).toBe(2);
    expect(r!.betasEstimated).toBe(true); // 2 of 3 > half
    expect(r!.bookImpactUsd).toBeCloseTo(-440.95855184409845, 4);
    expect(r!.withCandidateImpactUsd).toBeCloseTo(-385.5237624694118, 4);
  });

  it("does NOT flag betasEstimated when at most half the book lacks a beta", () => {
    const r = stressScenario({
      positions: [
        { symbol: "A", marketValue: 5_000 }, // no beta (1 of 2)
        { symbol: "B", marketValue: 5_000, beta: 1.2 }
      ],
      equity: 50_000
    });
    expect(r).toBeDefined();
    expect(r!.betaEstimatedCount).toBe(1);
    expect(r!.betasEstimated).toBe(false); // 1 of 2 is not > half
  });

  it("returns undefined when equity is 0 or negative", () => {
    expect(stressScenario({ positions: [], equity: 0 })).toBeUndefined();
    expect(stressScenario({ positions: [], equity: -1000 })).toBeUndefined();
  });

  it("topContributors are the top-3 existing positions by |impact|, largest first", () => {
    const r = stressScenario({
      positions: [
        { symbol: "SMALL", marketValue: 100, beta: 1 },
        { symbol: "BIG", marketValue: 20_000, beta: 1.5 },
        { symbol: "MED", marketValue: 5_000, beta: 1 },
        { symbol: "MED2", marketValue: 5_000, beta: 1.1 },
        { symbol: "TINY", marketValue: 50, beta: 1 }
      ],
      equity: 100_000,
      vix: 20,
      shockSigmas: 2
    });
    expect(r).toBeDefined();
    expect(r!.topContributors).toHaveLength(3);
    expect(r!.topContributors[0].symbol).toBe("BIG");
    expect(r!.topContributors.map((c) => c.symbol)).toEqual(["BIG", "MED2", "MED"]);
  });

  it("defaults vix to 20 and shockSigmas to 2 when omitted/invalid", () => {
    const r = stressScenario({ positions: [], equity: 100_000 });
    expect(r!.shockPct).toBeCloseTo(-2.519763153394848, 6);
    const rInvalid = stressScenario({ positions: [], equity: 100_000, vix: -5, shockSigmas: 0 });
    expect(rInvalid!.shockPct).toBeCloseTo(-2.519763153394848, 6);
  });
});

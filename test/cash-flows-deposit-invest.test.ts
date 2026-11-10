import { describe, expect, it } from "vitest";
import { inferExternalCashFlows } from "../src/lib/cash-flows";
import { normalizeAgainstBenchmark } from "../src/lib/benchmark";
import type { EquityCurvePoint } from "../src/lib/types";

/**
 * Owner bug (Alpaca Paper / Sandbox): account shows ~+50% vs SPY despite ~$100k start
 * and flat/down trading. Sparse portfolio snapshots + missing fills for the buys made
 * "deposit then invest" look like pure equity growth (no external flow neutralized).
 */
describe("deposit then invest without fills (paper vs-SPY inflation)", () => {
  it("neutralizes concurrent deposit when cash falls and positions rise without fill receipts", () => {
    const equity = [
      {
        timestamp: "2026-01-02T16:00:00Z",
        equity: 66_000,
        cash: 66_000,
        positionsValue: 0,
        source: "paper" as const
      },
      {
        timestamp: "2026-06-01T16:00:00Z",
        equity: 99_000,
        cash: 5_000,
        positionsValue: 94_000,
        source: "paper" as const
      }
    ];
    const flows = inferExternalCashFlows(equity, []);
    // ~$33k external deposit (99k − 66k); must not be left as market alpha.
    expect(flows.get("2026-06-01")).toBeCloseTo(33_000, -2);

    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-06-01", close: 520 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    // Zero-mtm residual after neutralizing deposit → ~0% account TWR, not +50%.
    expect(r.accountReturnPct).toBeCloseTo(0, 0);
    expect(r.benchmarkReturnPct).toBeCloseTo(4, 0);
    expect(r.excessReturnPct).toBeLessThan(5);
    expect(r.cashFlowAdjusted).toBe(true);

    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeGreaterThan(40);
  });

  it("does not invent a deposit for a pure cash→stock conversion (no equity change)", () => {
    const equity = [
      {
        timestamp: "2026-01-02T16:00:00Z",
        equity: 100_000,
        cash: 100_000,
        positionsValue: 0,
        source: "paper" as const
      },
      {
        timestamp: "2026-01-03T16:00:00Z",
        equity: 100_000,
        cash: 40_000,
        positionsValue: 60_000,
        source: "paper" as const
      }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
  });

  it("does not treat modest mark-to-market after a buy as a deposit", () => {
    // Bought $50k of stock; positions then mark +$2k. Residual equity is small vs swap.
    const equity = [
      {
        timestamp: "2026-01-02T16:00:00Z",
        equity: 100_000,
        cash: 100_000,
        positionsValue: 0,
        source: "paper" as const
      },
      {
        timestamp: "2026-01-10T16:00:00Z",
        equity: 102_000,
        cash: 50_000,
        positionsValue: 52_000,
        source: "paper" as const
      }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
    const spy = [
      { date: "2026-01-02", close: 100 },
      { date: "2026-01-10", close: 101 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows.size ? flows : undefined)!;
    // Real ~+2% account return should survive (not neutralized as a deposit).
    expect(r.accountReturnPct).toBeCloseTo(2, 0);
  });
});

describe("broker-reported equity-only history (Alpaca portfolio history fallback, PR #4971)", () => {
  it("never invents a transfer from an equity-only market move between broker-history points", () => {
    // No cash/positions split and no fills: a +2% / −1.5% market day must stay market return,
    // not be neutralized into a phantom deposit/withdrawal (Kody 4433485074, sentry 4433471476).
    const curve: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100_000, source: "paper", brokerHistory: true },
      { timestamp: "2026-07-02T16:00:00Z", equity: 102_000, source: "paper", brokerHistory: true },
      { timestamp: "2026-07-06T16:00:00Z", equity: 100_470, source: "paper", brokerHistory: true }
    ];
    expect(inferExternalCashFlows(curve, []).size).toBe(0);
  });

  it("does not invent a transfer between the last broker-history point and a live cash tip", () => {
    const curve: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100_000, source: "paper", brokerHistory: true },
      { timestamp: "2026-07-02T16:00:00Z", equity: 101_000, source: "paper", brokerHistory: true },
      { timestamp: "2026-07-03T19:00:00Z", equity: 103_000, source: "paper", cash: 40_000, positionsValue: 63_000 }
    ];
    expect(inferExternalCashFlows(curve, []).size).toBe(0);
  });

  it("still invents the transfer for the same move on a local equity-only, flat-book curve (unchanged)", () => {
    const curve: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100_000, source: "paper" },
      { timestamp: "2026-07-02T16:00:00Z", equity: 102_000, source: "paper" }
    ];
    expect(inferExternalCashFlows(curve, []).get("2026-07-02")).toBe(2_000);
  });
});

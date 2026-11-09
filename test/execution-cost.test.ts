import { afterEach, describe, expect, it } from "vitest";
import {
  applyExecutionCost,
  estimateExecutionCostBps,
  executionCostConfig,
  OOS_ROUND_TRIP_COST_BPS,
  PAPER_DEFAULT_BASE_SLIPPAGE_BPS
} from "../src/lib/execution-cost";

describe("estimateExecutionCostBps", () => {
  it("is zero with no inputs (no base, no spread, no impact)", () => {
    expect(estimateExecutionCostBps({ orderNotional: 1000, baseSlippageBps: 0, impactCoeff: 0 })).toBe(0);
  });

  it("adds the base floor and half the spread", () => {
    const bps = estimateExecutionCostBps({ spreadBps: 20, orderNotional: 0, baseSlippageBps: 5, impactCoeff: 0 });
    expect(bps).toBe(15); // 5 base + 10 half-spread
  });

  it("scales market impact with sqrt of participation (notional / dollar volume)", () => {
    // 1% participation, coeff 10 → 10 * sqrt(0.01) = 1bps
    const liquid = estimateExecutionCostBps({ orderNotional: 10_000, dollarVol: 1_000_000, baseSlippageBps: 0, impactCoeff: 10 });
    expect(liquid).toBeCloseTo(1, 5);
    // 10% participation → 10 * sqrt(0.1) ≈ 3.16bps — costs MORE in a thinner name
    const thin = estimateExecutionCostBps({ orderNotional: 100_000, dollarVol: 1_000_000, baseSlippageBps: 0, impactCoeff: 10 });
    expect(thin).toBeGreaterThan(liquid);
    expect(thin).toBeCloseTo(3.1623, 3);
  });
});

describe("applyExecutionCost — adverse direction", () => {
  it("a buy pays UP", () => {
    expect(applyExecutionCost(100, "buy", 50)).toBeCloseTo(100.5, 6); // +50bps
  });
  it("a cover pays UP", () => {
    expect(applyExecutionCost(100, "cover", 50)).toBeCloseTo(100.5, 6);
  });
  it("a sell receives DOWN", () => {
    expect(applyExecutionCost(100, "sell", 50)).toBeCloseTo(99.5, 6);
  });
  it("a short receives DOWN", () => {
    expect(applyExecutionCost(100, "short", 50)).toBeCloseTo(99.5, 6);
  });
  it("is a no-op for zero cost or zero price", () => {
    expect(applyExecutionCost(100, "buy", 0)).toBe(100);
    expect(applyExecutionCost(0, "buy", 50)).toBe(0);
  });
});

describe("executionCostConfig — default ON", () => {
  afterEach(() => {
    delete process.env.PAPER_EXECUTION_COST_MODEL;
    delete process.env.PAPER_EXECUTION_COST_BASE_BPS;
    delete process.env.PAPER_EXECUTION_IMPACT_COEFF;
  });

  it("is ENABLED with no env set (default ON)", () => {
    const cfg = executionCostConfig();
    expect(cfg.enabled).toBe(true);
    // Paper default is the OOS 20 bps constant — paper trains live.
    expect(cfg.baseSlippageBps).toBe(20);
    expect(cfg.baseSlippageBps).toBe(OOS_ROUND_TRIP_COST_BPS);
    expect(cfg.baseSlippageBps).toBe(PAPER_DEFAULT_BASE_SLIPPAGE_BPS);
    expect(PAPER_DEFAULT_BASE_SLIPPAGE_BPS).toBe(OOS_ROUND_TRIP_COST_BPS);
    expect(cfg.impactCoeff).toBe(10); // default impact coeff
  });

  it("can be disabled with an explicit opt-out flag", () => {
    for (const val of ["0", "false", "off", "no"]) {
      process.env.PAPER_EXECUTION_COST_MODEL = val;
      expect(executionCostConfig().enabled).toBe(false);
    }
  });

  it("truthy flag values keep it enabled", () => {
    process.env.PAPER_EXECUTION_COST_MODEL = "on";
    const cfg = executionCostConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.impactCoeff).toBe(10);
  });

  it("a positive base bps override is used when set, keeps it enabled", () => {
    process.env.PAPER_EXECUTION_COST_BASE_BPS = "8";
    process.env.PAPER_EXECUTION_IMPACT_COEFF = "20";
    const cfg = executionCostConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseSlippageBps).toBe(8);
    expect(cfg.impactCoeff).toBe(20);
  });
});

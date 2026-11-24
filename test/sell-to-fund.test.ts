/**
 * PR 3 — sell-to-fund-buy planner (pure decision core). No DB/broker/clock, so these tests fully
 * pin the selection + sizing + safety behavior that the strategy loop relies on.
 */
import { describe, expect, it } from "vitest";
import { planFundingSells, type PlanFundingSellsInput } from "../src/lib/sell-to-fund";

const base: Omit<PlanFundingSellsInput, "mode"> = {
  buyingPower: 0,
  intendedOpeningNotional: 1000,
  positions: [
    { symbol: "WIN", quantity: 10, marketValue: 2000, averageCost: 100 }, // +1000 unrealized
    { symbol: "LOSE", quantity: 10, marketValue: 600, averageCost: 100 } // -400 unrealized (sell first)
  ],
  currentPrices: { WIN: 200, LOSE: 60 },
  excludeSymbols: []
};

describe("planFundingSells (PR 3)", () => {
  it("off mode is a no-op even with a shortfall", () => {
    const plan = planFundingSells({ ...base, mode: "off" });
    expect(plan.sells).toEqual([]);
    expect(plan.shortfall).toBe(0);
  });

  it("no shortfall → empty plan", () => {
    const plan = planFundingSells({ ...base, mode: "automated", buyingPower: 5000 });
    expect(plan.shortfall).toBe(0);
    expect(plan.sells).toEqual([]);
  });

  it("trims the largest unrealized loser first and sizes shares to cover the shortfall", () => {
    // shortfall = 1000 - 0 = 1000. LOSE @ $60 → ceil(1000/60)=17 shares but only 10 held → sells 10 ($600),
    // then WIN @ $200 → ceil(400/200)=2 shares ($400). Total raised 1000.
    const plan = planFundingSells({ ...base, mode: "automated" });
    expect(plan.shortfall).toBe(1000);
    expect(plan.sells.map((s) => s.symbol)).toEqual(["LOSE", "WIN"]);
    expect(plan.sells[0]).toMatchObject({ side: "sell", type: "market", quantity: 10, tradeThesisTag: "Sell-to-Fund" });
    expect(plan.sells[1]).toMatchObject({ symbol: "WIN", quantity: 2 });
    expect(plan.raised).toBeGreaterThanOrEqual(plan.shortfall);
  });

  it("never sells the buy targets (excludeSymbols)", () => {
    const plan = planFundingSells({ ...base, mode: "propose", excludeSymbols: ["lose"] });
    // LOSE excluded → must fund from WIN only: ceil(1000/200)=5 shares ($1000).
    expect(plan.sells.map((s) => s.symbol)).toEqual(["WIN"]);
    expect(plan.sells[0].quantity).toBe(5);
  });

  it("only sells long positions (skips shorts / zero) and reports best-effort when holdings can't cover", () => {
    const plan = planFundingSells({
      ...base,
      mode: "automated",
      intendedOpeningNotional: 100000, // huge shortfall
      positions: [
        { symbol: "SHORT", quantity: -5, marketValue: 500, averageCost: 100 }, // short → skip
        { symbol: "TINY", quantity: 1, marketValue: 50, averageCost: 40 }
      ],
      currentPrices: { TINY: 50 }
    });
    expect(plan.sells.map((s) => s.symbol)).toEqual(["TINY"]);
    expect(plan.raised).toBeLessThan(plan.shortfall);
    expect(plan.summary).toMatch(/best effort/i);
  });

  it("ranks liquidation candidates by lowest forward score and tax/wash-sale efficiency instead of raw dollar loss", () => {
    const plan = planFundingSells({
      mode: "automated",
      buyingPower: 0,
      intendedOpeningNotional: 500,
      positions: [
        // BIG_LOSS has a larger raw dollar loss (-$600), but high forward conviction (85) AND active wash-sale risk
        { symbol: "BIG_LOSS", quantity: 20, marketValue: 1400, averageCost: 100, forwardScore: 85, washSaleRisk: true },
        // LOW_SCORE_HARVEST has a smaller raw dollar loss (-$100), weak forward score (25), and clean tax-loss harvest
        { symbol: "LOW_SCORE", quantity: 10, marketValue: 500, averageCost: 60, forwardScore: 25, washSaleRisk: false },
        // LT_GAIN vs ST_GAIN: when scores are equal, prefers harvesting lower tax-drag long-term lot over short-term high-rate lot
        { symbol: "ST_WIN", quantity: 10, marketValue: 1000, averageCost: 50, forwardScore: 60, holdingDays: 30 },
        { symbol: "LT_WIN", quantity: 10, marketValue: 1000, averageCost: 50, forwardScore: 60, holdingDays: 400 }
      ],
      currentPrices: { BIG_LOSS: 70, LOW_SCORE: 50, ST_WIN: 100, LT_WIN: 100 },
      excludeSymbols: []
    });

    // LOW_SCORE is liquidated first despite smaller raw dollar loss (-$100 vs -$600)
    expect(plan.sells.map((s) => s.symbol)).toEqual(["LOW_SCORE"]);
    expect(plan.sells[0]?.quantity).toBe(10);
    expect(plan.raised).toBe(500);
  });

  it("applies Math.ceil overshoot guard when a high-priced share would massively overshoot remaining shortfall and a finer-grained candidate can cover", () => {
    const plan = planFundingSells({
      mode: "automated",
      buyingPower: 0,
      intendedOpeningNotional: 100,
      positions: [
        { symbol: "HIGH_PX", quantity: 5, marketValue: 2500, averageCost: 500, forwardScore: 30 },
        { symbol: "FINE_PX", quantity: 10, marketValue: 250, averageCost: 25, forwardScore: 35 }
      ],
      currentPrices: { HIGH_PX: 500, FINE_PX: 25 },
      excludeSymbols: []
    });

    // 1 share of HIGH_PX ($500) would overshoot the $100 shortfall by 5x ($400 overshoot);
    // the guard skips the 1-share ceil overshoot on HIGH_PX and sells 4 shares of FINE_PX ($100) instead.
    expect(plan.sells.map((s) => s.symbol)).toEqual(["FINE_PX"]);
    expect(plan.sells[0]?.quantity).toBe(4);
    expect(plan.raised).toBe(100);
  });
});

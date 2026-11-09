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
});

import { describe, it, expect } from "vitest";
import { deriveMacroMetrics } from "../src/lib/macro-metrics";
import type { MacroData } from "../src/lib/macro";

function macro(overrides: Partial<MacroData> = {}): MacroData {
  return {
    fedFundsRate: "5.25%",
    dgs3moTreasury: "5.10%",
    dgs2Treasury: "4.60%",
    dgs10Treasury: "4.20%",
    inflationExpectation10y: "2.30%",
    cpiInflation: "3.10%",
    corePCE: "2.80%",
    realGDPGrowth: "2.00%",
    unemploymentRate: "3.90%",
    initialClaims: "220K",
    m2MoneySupply: "20.80T",
    m2GrowthYoY: "2.50%",
    hyCreditSpread: "3.20%",
    usdIndex: "121.00",
    wtiOil: "$75.00",
    housingStarts: "1.30M",
    consumerSentiment: "75.0",
    nonfarmPayrollsChangeK: "+150K",
    vix: "15.00",
    vix3m: "17.00",
    asOf: "2026-06-17",
    ...overrides
  };
}

describe("deriveMacroMetrics", () => {
  it("computes curve spread, real rates, and misery index from percent strings", () => {
    const m = deriveMacroMetrics(macro());
    expect(m.curve3m10y).toBe(-0.9); // 4.20 - 5.10 (inverted 3m10y)
    expect(m.curve2s10s).toBe(-0.4); // 4.20 - 4.60 (inverted 2s10s)
    expect(m.yieldCurveSpread).toBe(-1.05); // 4.20 - 5.25 (inverted)
    expect(m.vixTermStructure).toBeCloseTo(15 / 17, 2); // VIX / VIX3M (contango, <1)
    expect(m.real10Y).toBe(1.1); // 4.20 - 3.10
    expect(m.realFedFunds).toBe(2.15); // 5.25 - 3.10 (restrictive)
    expect(m.miseryIndex).toBe(7); // 3.90 + 3.10
  });

  it("computes equity risk premium only when a market earnings yield is provided", () => {
    expect(deriveMacroMetrics(macro()).equityRiskPremium).toBeUndefined();
    const m = deriveMacroMetrics(macro(), { marketEarningsYield: 6 });
    expect(m.equityRiskPremium).toBe(1.8); // 6 - 4.20
  });

  it("flags a normal (non-inverted) curve with a positive spread", () => {
    const m = deriveMacroMetrics(macro({ fedFundsRate: "2.00%", dgs10Treasury: "4.00%" }));
    expect(m.yieldCurveSpread).toBe(2);
  });

  it("omits metrics whose inputs are missing or unparseable", () => {
    const m = deriveMacroMetrics(macro({ cpiInflation: "", dgs10Treasury: "n/a" }));
    expect(m.real10Y).toBeUndefined();
    expect(m.realFedFunds).toBeUndefined();
    expect(m.miseryIndex).toBeUndefined();
    expect(m.yieldCurveSpread).toBeUndefined(); // dgs10 unparseable
  });

  it("derives NOTHING from the VIX-only fallback shape (all FRED fields blank) except VIX-gated terms", () => {
    // fetchVixOnlyFallback blanks every FRED field to "" — no derived metric may be computed
    // off placeholder constants, so none of these can enter the strategy prompt or the console.
    const blank = Object.fromEntries(
      Object.entries(macro()).map(([k, v]) => [k, typeof v === "string" ? "" : v])
    ) as unknown as MacroData;
    const m = deriveMacroMetrics({ ...blank, vix: "22.50", asOf: "2026-06-21" }, { marketEarningsYield: 6 });
    expect(m.curve3m10y).toBeUndefined();
    expect(m.curve2s10s).toBeUndefined();
    expect(m.yieldCurveSpread).toBeUndefined();
    expect(m.real10Y).toBeUndefined();
    expect(m.realFedFunds).toBeUndefined();
    expect(m.miseryIndex).toBeUndefined();
    expect(m.vixTermStructure).toBeUndefined(); // vix3m is blank — no fabricated term structure
    expect(m.equityRiskPremium).toBeUndefined(); // 10Y is blank
  });
});

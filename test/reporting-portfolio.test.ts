import { describe, expect, it } from "vitest";
import { finalReportingPortfolio } from "../src/lib/reporting-portfolio";
import { inferTodayExternalFlow } from "../src/lib/cash-flows";
import type { FillEvent, Portfolio } from "../src/lib/types";
import { readFileSync } from "node:fs";
const producer: Portfolio = { accountNumber: "synthetic-reporting", totalMarketValue: 100000,
  cash: 60000, buyingPower: 60000, equityMarketValue: 40000, optionMarketValue: 0,
  cashRequestStartedAt: "2026-11-20T19:00:00Z" };

describe("final reporting copy and producer evidence", () => {
  it("preserves unchanged producer values with original proof, without aliasing", () => {
    const current = { ...producer };
    const final = finalReportingPortfolio(current, producer);
    expect(final).toEqual(producer);
    expect(final).not.toBe(current);
    current.cash = 1;
    expect(final.cash).toBe(60000);
    expect(producer.cash).toBe(60000);
  });
  it.each(["cash"] as const)(
    "keeps final %s estimates but removes producer proof after mutation", (field) => {
      const current = { ...producer, [field]: producer[field] + 2000 };
      const final = finalReportingPortfolio(current, producer);
      expect(final[field]).toBe(producer[field] + 2000);
      expect(final.cashRequestStartedAt).toBeUndefined();
      expect(producer.cashRequestStartedAt).toBe("2026-11-20T19:00:00Z");
    });
  it.each(["totalMarketValue", "buyingPower", "equityMarketValue", "optionMarketValue"] as const)(
    "preserves cash proof when only %s changes", (field) => {
      const final = finalReportingPortfolio({ ...producer, [field]: producer[field] + 2000 }, producer);
      expect(final[field]).toBe(producer[field] + 2000);
      expect(final.cash).toBe(producer.cash);
      expect(final.cashRequestStartedAt).toBe(producer.cashRequestStartedAt);
    });
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])("unknown cash %s cannot retain proof", (cash) => {
    expect(finalReportingPortfolio(producer, producer).cashRequestStartedAt).toBe(producer.cashRequestStartedAt);
    const current = { ...producer, cash };
    expect(finalReportingPortfolio(current, { ...producer, cash }).cashRequestStartedAt).toBeUndefined();
  });
  it("does not trust metadata changed by later strategy work", () => {
    expect(finalReportingPortfolio({ ...producer, cashRequestStartedAt: "2026-11-20T20:00:00Z" }, producer)
      .cashRequestStartedAt).toBe(producer.cashRequestStartedAt);
    expect(finalReportingPortfolio({ ...producer }, { ...producer, cashRequestStartedAt: undefined })
      .cashRequestStartedAt).toBeUndefined();
  });
  it("keeps initial and final writer call sites distinct", () => {
    const source = readFileSync(new URL("../src/lib/strategy.ts", import.meta.url), "utf8");
    expect(source).toContain("const finalSnapshotPortfolio = finalReportingPortfolio(portfolio, snapshotPortfolio)");
    expect(source).toContain("portfolio: finalSnapshotPortfolio,");
    expect(source).toContain("portfolio: snapshotPortfolio, positions: workingPositions");
  });
});

it("equity-only final changes preserve genuine withdrawal inference, changed cash stays unknown", () => {
  const capture: Portfolio = { ...producer, cash: 53000, totalMarketValue: 94000,
    cashRequestStartedAt: "2026-11-20T19:00:00Z" };
  const final = finalReportingPortfolio({ ...capture, totalMarketValue: 95000, equityMarketValue: 42000 }, capture);
  const baseline = { timestamp: "2026-11-19T20:00:00Z", equity: 100000, cash: 60000,
    source: "live" as const, cashRequestStartedAt: "2026-11-19T19:00:00Z" };
  const fill: FillEvent = { id: "synthetic-report-fill", accountNumber: producer.accountNumber,
    source: "live", symbol: "SYNTH", side: "buy", quantity: 1, price: 2000, notional: 2000,
    status: "filled", filledAt: "2026-11-20T18:00:00Z" };
  const infer = (portfolio: Portfolio) => inferTodayExternalFlow({ baseline, fills: [fill],
    currentEquity: portfolio.totalMarketValue, currentCash: portfolio.cash,
    currentCashRequestStartedAt: portfolio.cashRequestStartedAt, now: new Date("2026-11-20T20:00:00Z") });
  expect(infer(final)).toBe(-5000);
  const altered = finalReportingPortfolio({ ...capture, cash: 52000 }, capture);
  expect(altered.cash).toBe(52000);
  expect(infer(altered)).toBeUndefined();
});

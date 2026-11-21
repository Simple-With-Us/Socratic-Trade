import { describe, expect, it } from "vitest";
import { finalReportingPortfolio } from "../src/lib/reporting-portfolio";
import type { Portfolio } from "../src/lib/types";
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
  it.each(["cash", "totalMarketValue", "buyingPower", "equityMarketValue", "optionMarketValue"] as const)(
    "keeps final %s estimates but removes producer proof after mutation", (field) => {
      const current = { ...producer, [field]: producer[field] + 2000 };
      const final = finalReportingPortfolio(current, producer);
      expect(final[field]).toBe(producer[field] + 2000);
      expect(final.cashRequestStartedAt).toBeUndefined();
      expect(producer.cashRequestStartedAt).toBe("2026-11-20T19:00:00Z");
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

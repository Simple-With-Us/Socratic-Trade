import { describe, expect, it } from "vitest";
import { parseRoicFinancialStatements, formatMultiYearFinancialDoc } from "../src/lib/web-sources/roic-financials";

describe("roic-financials", () => {
  it("parses multi-year financial statements and computes trends", () => {
    const mockJson = {
      financials: [
        { year: 2021, revenue: 100_000_000, gross_profit: 40_000_000, operating_income: 20_000_000, net_income: 15_000_000, free_cash_flow: 18_000_000 },
        { year: 2022, revenue: 120_000_000, gross_profit: 50_000_000, operating_income: 26_000_000, net_income: 20_000_000, free_cash_flow: 22_000_000 },
        { year: 2023, revenue: 140_000_000, gross_profit: 62_000_000, operating_income: 32_000_000, net_income: 25_000_000, free_cash_flow: 28_000_000 },
        { year: 2024, revenue: 165_000_000, gross_profit: 76_000_000, operating_income: 40_000_000, net_income: 32_000_000, free_cash_flow: 35_000_000, total_equity: 150_000_000, total_debt: 50_000_000, cash_and_equivalents: 20_000_000 }
      ]
    };

    const metrics = parseRoicFinancialStatements(mockJson, "NVDA");
    expect(metrics).not.toBeNull();
    expect(metrics?.symbol).toBe("NVDA");
    expect(metrics?.years.length).toBe(4);
    expect(metrics?.revenueCagr3Y).toBeGreaterThan(15);
    expect(metrics?.grossMarginTrajectory).toBe("expanding");
    expect(metrics?.operatingMarginTrajectory).toBe("expanding");
    expect(metrics?.latestFcfConversion).toBeGreaterThan(100);
    expect(metrics?.latestRoic).toBeGreaterThan(15);
  });

  it("formats structured multi-year financial document for RAG", () => {
    const mockJson = {
      financials: [
        { year: 2022, revenue: 100_000_000, operating_income: 20_000_000, free_cash_flow: 18_000_000 },
        { year: 2023, revenue: 120_000_000, operating_income: 25_000_000, free_cash_flow: 22_000_000 }
      ]
    };

    const metrics = parseRoicFinancialStatements(mockJson, "AAPL");
    expect(metrics).not.toBeNull();
    const doc = formatMultiYearFinancialDoc(metrics!);
    expect(doc).toContain("# AAPL Multi-Year Financial Analysis Summary");
    expect(doc).toContain("Revenue ($M)");
  });
});

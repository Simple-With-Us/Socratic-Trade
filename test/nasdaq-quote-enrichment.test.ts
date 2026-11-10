import { describe, expect, it } from "vitest";
import {
  parseNasdaqInstitutionalHoldings,
  parseNasdaqQuoteInfo,
  parseNasdaqQuoteSummary,
  parseRoicProfile,
  parseRoicRatios
} from "../src/lib/data-providers";

describe("parseNasdaqQuoteInfo", () => {
  it("parses price, volume, company name, and 52w range", () => {
    const result = parseNasdaqQuoteInfo({
      data: {
        companyName: "Apple Inc. Common Stock",
        primaryData: {
          lastSalePrice: "$333.02",
          percentageChange: "+3.53%",
          volume: "47,489,726"
        },
        keyStats: { fiftyTwoWeekHighLow: { value: "201.50 - 334.99" } }
      }
    });
    expect(result.companyName).toBe("Apple Inc.");
    expect(result.price).toBeCloseTo(333.02, 2);
    expect(result.intradayChangePct).toBeCloseTo(3.53, 2);
    expect(result.volume).toBe(47489726);
    expect(result.fiftyTwoWeekLow).toBeCloseTo(201.5, 1);
    expect(result.fiftyTwoWeekHigh).toBeCloseTo(334.99, 2);
  });
});

describe("parseNasdaqQuoteSummary", () => {
  it("parses sector, industry, yield, target, and High/Low range", () => {
    const result = parseNasdaqQuoteSummary({
      data: {
        summaryData: {
          Sector: { value: "Technology" },
          Industry: { value: "Computer Manufacturing" },
          Yield: { value: "0.34%" },
          OneYrTarget: { value: "$329.50" },
          FiftTwoWeekHighLow: { value: "$334.99/$201.5" }
        }
      }
    });
    expect(result.sector).toBe("Technology");
    expect(result.industry).toBe("Computer Manufacturing");
    expect(result.dividendYield).toBeCloseTo(0.34, 2);
    expect(result.targetMean).toBeCloseTo(329.5, 1);
    expect(result.fiftyTwoWeekHigh).toBeCloseTo(334.99, 2);
    expect(result.fiftyTwoWeekLow).toBeCloseTo(201.5, 1);
  });
});

describe("parseNasdaqInstitutionalHoldings", () => {
  it("parses institutional ownership percent", () => {
    const result = parseNasdaqInstitutionalHoldings({
      data: {
        ownershipSummary: {
          SharesOutstandingPCT: { label: "Institutional Ownership", value: "75.68%" }
        }
      }
    });
    expect(result.institutionOwnershipPct).toBeCloseTo(75.68, 2);
  });
});

describe("parseRoicProfile", () => {
  it("maps snake_case profile fields", () => {
    const result = parseRoicProfile({
      company_name: "Apple Inc.",
      sector: "Technology",
      industry: "Consumer Electronics",
      price: 333.02,
      dividend_yield: 0.0034,
      short_shares_outstanding_percentage: 0.007,
      percentage_held_by_institutions: 0.62
    });
    expect(result.companyName).toBe("Apple Inc.");
    expect(result.sector).toBe("Technology");
    expect(result.price).toBeCloseTo(333.02, 2);
    expect(result.dividendYield).toBeCloseTo(0.34, 2);
    expect(result.shortPercentOfFloat).toBeCloseTo(0.7, 1);
    expect(result.institutionOwnershipPct).toBeCloseTo(62, 0);
  });
});

describe("parseRoicRatios", () => {
  it("maps ratio aliases when present", () => {
    const result = parseRoicRatios({ peRatio: 28.5, pb: 45, eps: 6.4, returnOnEquity: 1.5, debt_to_equity: 1.8 });
    expect(result.peRatio).toBeCloseTo(28.5, 1);
    expect(result.pbRatio).toBe(45);
    expect(result.eps).toBeCloseTo(6.4, 1);
    // normalizePercent only scales values in [-1, 1]; 1.5 is already treated as percent points.
    expect(result.returnOnEquity).toBeCloseTo(1.5, 1);
    expect(result.debtToEquity).toBeCloseTo(1.8, 1);
  });
});

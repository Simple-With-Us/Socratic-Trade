import { describe, expect, it } from "vitest";
import {
  parseFilingApiCompany,
  parseFilingApiEarningsCalendar,
  parseFilingApiInsiderSummary,
  parseRealTimeFinanceNews,
  parseRealTimeFinanceQuote,
  parseSeekingAlphaArticles,
  parseSeekingAlphaKeyStats,
  parseYhFinanceApiDojoSummary,
  secXbrlEnrichmentEnabled
} from "../src/lib/data-providers";

describe("secXbrlEnrichmentEnabled default", () => {
  it("defaults ON when unset", () => {
    const prev = process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    expect(secXbrlEnrichmentEnabled()).toBe(true);
    if (prev === undefined) delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    else process.env.SEC_XBRL_ENRICHMENT_ENABLED = prev;
  });
});

describe("FilingAPI.dev parsers", () => {
  it("parses company sector/industry", () => {
    expect(
      parseFilingApiCompany({
        ticker: "AAPL",
        sector: "Technology",
        industry: "Consumer Electronics",
        filing_count: 5
      })
    ).toEqual({
      companyName: "AAPL",
      sector: "Technology",
      industry: "Consumer Electronics"
    });
  });

  it("parses earnings calendar into daysToEarnings", () => {
    const now = Date.parse("2026-07-26T12:00:00Z");
    const result = parseFilingApiEarningsCalendar(
      {
        earnings: [{ symbol: "AAPL", date: "2026-07-30", hour: "amc" }]
      },
      "AAPL",
      now
    );
    expect(result.daysToEarnings).toBe(4);
  });

  it("maps insider sell_ratio to sentiment", () => {
    expect(parseFilingApiInsiderSummary({ sell_ratio: 1, signal: "net_selling" }).insiderSentiment).toBe(10);
    expect(parseFilingApiInsiderSummary({ sell_ratio: 0, signal: "net_buying" }).insiderSentiment).toBe(90);
  });
});

describe("Real-Time Finance Data parsers", () => {
  it("parses stock-quote", () => {
    const result = parseRealTimeFinanceQuote({
      status: "OK",
      data: {
        symbol: "AAPL:NASDAQ",
        name: "Apple Inc",
        price: 333.02,
        change_percent: 3.5317,
        volume: 47489415
      }
    });
    expect(result.companyName).toBe("Apple Inc");
    expect(result.price).toBeCloseTo(333.02, 2);
    expect(result.intradayChangePct).toBeCloseTo(3.5317, 3);
    expect(result.volume).toBe(47489415);
  });

  it("parses stock-news into headlines + keyword sentiment", () => {
    const result = parseRealTimeFinanceNews({
      data: {
        news: [
          { article_title: "Apple stock surges on strong growth" },
          { article_title: "Why Apple Stock Is Up Today" }
        ]
      }
    });
    expect(result.headlines?.length).toBe(2);
    expect(result.sentiment).toBeGreaterThan(50);
  });
});

describe("YH Finance ApiDojo summary parser", () => {
  it("reads Yahoo-style raw leaves", () => {
    const result = parseYhFinanceApiDojoSummary({
      quoteType: { longName: "Apple Inc." },
      summaryProfile: { sector: "Technology", industry: "Consumer Electronics" },
      summaryDetail: {
        trailingPE: { raw: 28.5 },
        dividendYield: { raw: 0.0034 },
        fiftyTwoWeekHigh: { raw: 334.99 },
        fiftyTwoWeekLow: { raw: 201.5 },
        beta: { raw: 1.1 }
      },
      price: {
        regularMarketPrice: { raw: 333.02 },
        regularMarketChangePercent: { raw: 0.0353 },
        regularMarketVolume: { raw: 47_000_000 }
      },
      financialData: {
        recommendationMean: { raw: 2.0 },
        targetMeanPrice: { raw: 329.5 },
        returnOnEquity: { raw: 1.5 }
      },
      defaultKeyStatistics: {
        shortPercentOfFloat: { raw: 0.007 },
        trailingEps: { raw: 7.1 },
        priceToBook: { raw: 45 }
      }
    });
    expect(result.companyName).toBe("Apple Inc.");
    expect(result.sector).toBe("Technology");
    expect(result.price).toBeCloseTo(333.02, 2);
    expect(result.intradayChangePct).toBeCloseTo(3.53, 1);
    expect(result.peRatio).toBeCloseTo(28.5, 1);
    expect(result.dividendYield).toBeCloseTo(0.34, 2);
    expect(result.shortPercentOfFloat).toBeCloseTo(0.7, 1);
    expect(result.analystBySource?.["yh-finance-apidojo"]?.label).toBeTruthy();
  });
});

describe("Seeking Alpha parsers", () => {
  it("parses flat key-stats", () => {
    const result = parseSeekingAlphaKeyStats({
      data: { peRatio: 30, eps: 6.5, sector: "Technology", companyName: "Apple Inc." }
    });
    expect(result.peRatio).toBe(30);
    expect(result.eps).toBeCloseTo(6.5, 1);
    expect(result.sector).toBe("Technology");
  });

  it("parses articles list titles", () => {
    const result = parseSeekingAlphaArticles({
      data: [{ attributes: { title: "Apple beats expectations" } }, { title: "iPhone demand rises" }]
    });
    expect(result.headlines).toEqual(["Apple beats expectations", "iPhone demand rises"]);
  });
});

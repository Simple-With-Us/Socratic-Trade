import { describe, expect, it } from "vitest";
import { cellTitle, formatSourceList, friendlySource, orderedSourceEntries, provenanceLabel } from "../src/lib/dashboard-ui";

describe("dashboard UI provenance helpers", () => {
  it("orders provenance entries in presentation order and keeps unknown fields at the end", () => {
    const entries = orderedSourceEntries({
      senateTrades: "congress",
      sentiment: "alpha-vantage",
      price: "alpaca-quotes",
      companyName: "nasdaq-delayed-screener",
      // Simulate a future sourced field that has not been added to the order list yet.
      customField: "future-provider"
    } as never);

    expect(entries).toEqual([
      ["companyName", "nasdaq-delayed-screener"],
      ["price", "alpaca-quotes"],
      ["sentiment", "alpha-vantage"],
      ["senateTrades", "congress"],
      ["customField", "future-provider"]
    ]);
  });

  it("formats provenance labels and source names for the drawer", () => {
    expect(provenanceLabel("fcfYield")).toBe("FCF yield");
    expect(friendlySource("nasdaq-delayed-screener")).toBe("NASDAQ Delayed Screener");
    expect(friendlySource("congress")).toBe("Congress.Trade");
    expect(friendlySource("congress.trade")).toBe("Congress.Trade");
    expect(friendlySource("yahoo-finance-delayed-quotes")).toBe("Yahoo Finance Delayed Quotes");
    expect(friendlySource("alpha-vantage")).toBe("alpha-vantage");
  });

  it("only stamps 'Received' freshness on cells with a recorded source", () => {
    const asOf = new Date().toISOString();
    const sourced = cellTitle("News tone 62/100", "finnhub", asOf);
    expect(sourced).toContain("Source: Finnhub");
    expect(sourced).toContain("Received");
    // No source recorded → no provider returned the field; stamping "Received <time>"
    // would claim freshness for data we never got.
    expect(cellTitle("News tone", undefined, asOf)).toBe("News tone");
  });

  it("dedupes aliased Market Scan source labels", () => {
    expect(
      formatSourceList(
        "nasdaq-delayed-screener+congress.trade+tiingo+finnhub+fmp+yahoo-finance+finra+computed+congress+congress.trade+sec-edgar+blackrock-oef-holdings+yahoo-finance-delayed-quotes"
      )
    ).toBe("NASDAQ Delayed Screener, Congress.Trade, Tiingo, Finnhub, FMP, Yahoo Finance, FINRA, Computed, SEC EDGAR, BlackRock Holdings, Yahoo Finance Delayed Quotes");
  });

  it("labels every IndexUniverse scan source from the shared product names, not slugs", () => {
    // market.ts builds these as `${universe}-universe` from the raw IndexUniverse id.
    // camelCase ids lowercase to nasdaqcomposite-universe; missing keys used to
    // titleize as "Nasdaqcomposite Universe" or leak "dow30-universe" via friendlySource.
    expect(formatSourceList("sp100-universe")).toBe("S&P 100 Universe");
    expect(formatSourceList("sp500-universe")).toBe("S&P 500 Universe");
    expect(formatSourceList("nasdaq100-universe")).toBe("Nasdaq 100 Universe");
    expect(formatSourceList("nasdaqComposite-universe")).toBe("Nasdaq Composite Universe");
    expect(formatSourceList("dow30-universe")).toBe("Dow 30 Universe");
    expect(formatSourceList("russell2000-universe")).toBe("Russell 2000 Universe");
    expect(formatSourceList("nyseComposite-universe")).toBe("NYSE Composite Universe");
    expect(formatSourceList("ftWilshire5000-universe")).toBe("FT Wilshire 5000 Universe");
    expect(formatSourceList("sp500-universe+nasdaqComposite-universe+dow30-universe+nyseComposite-universe")).toBe(
      "S&P 500 Universe, Nasdaq Composite Universe, Dow 30 Universe, NYSE Composite Universe"
    );
    expect(formatSourceList("sp500-universe+nasdaqComposite-universe+dow30-universe+nyseComposite-universe")).not.toMatch(
      /sp500|nasdaqComposite|dow30|nyseComposite/
    );
    expect(friendlySource("dow30-universe")).toBe("Dow 30 Universe");
    expect(friendlySource("russell2000-universe")).toBe("Russell 2000 Universe");
    expect(friendlySource("nasdaqComposite-universe")).toBe("Nasdaq Composite Universe");
  });
});

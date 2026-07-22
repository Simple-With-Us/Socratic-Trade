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

  it("labels the camelCase dynamic-universe source tags market.ts actually emits, not a garbled title-case fallback", () => {
    // market.ts builds these as `${universe}-universe` from the raw IndexUniverse config id
    // (see loadDynamicUniverseQuotes) — nasdaqComposite/nyseComposite/ftWilshire5000 are the only
    // camelCase compound ids, and a mismatched/missing label-map key used to fall through to
    // titleizeSource's raw-string fallback ("Nasdaqcomposite Universe").
    expect(formatSourceList("nasdaqComposite-universe")).toBe("NASDAQ Composite Universe");
    expect(formatSourceList("nyseComposite-universe")).toBe("NYSE Composite Universe");
    expect(formatSourceList("ftWilshire5000-universe")).toBe("FT Wilshire 5000 Universe");
  });
});

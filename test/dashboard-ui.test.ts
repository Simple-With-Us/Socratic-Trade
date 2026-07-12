import { describe, expect, it } from "vitest";
import { formatSourceList, friendlySource, orderedSourceEntries, provenanceLabel } from "../src/lib/dashboard-ui";

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

  it("dedupes aliased Market Scan source labels", () => {
    expect(
      formatSourceList(
        "nasdaq-delayed-screener+congress.trade+tiingo+finnhub+fmp+yahoo-finance+finra+computed+congress+congress.trade+sec-edgar+blackrock-oef-holdings+yahoo-finance-delayed-quotes"
      )
    ).toBe("NASDAQ Delayed Screener, Congress.Trade, Tiingo, Finnhub, FMP, Yahoo Finance, FINRA, Computed, SEC EDGAR, BlackRock Holdings, Yahoo Finance Delayed Quotes");
  });
});

import { describe, expect, it } from "vitest";
import { approvalQuoteSymbols, buildApprovalQuoteScan } from "../src/lib/approval-quote-scan";

describe("approval quote scan", () => {
  it("quotes the proposal plus held names only", () => {
    expect(
      approvalQuoteSymbols({ symbol: "t" }, [
        { symbol: "AAPL", quantity: 1, marketValue: 200, averageCost: 180 },
        { symbol: "t", quantity: 2, marketValue: 50, averageCost: 24 }
      ])
    ).toEqual(["T", "AAPL"]);
  });

  it("builds a MarketScan from cascade quotes without a full screener", () => {
    const scan = buildApprovalQuoteScan(
      {
        T: {
          symbol: "T",
          price: 25.1,
          bid: 25.09,
          ask: 25.11,
          provider: "alpaca-snapshot",
          asOf: "2026-08-16T20:00:00.000Z"
        }
      },
      []
    );
    expect(scan.source).toBe("alpaca-snapshot");
    expect(scan.scannedSymbols).toBe(1);
    expect(scan.quotesBySymbol.T?.price).toBe(25.1);
    expect(scan.topCandidates[0]?.symbol).toBe("T");
    expect(scan.warnings).toEqual([]);
  });

  it("carries delayed Yahoo fallback onto the approval scan quote", () => {
    const scan = buildApprovalQuoteScan(
      {
        XOM: {
          symbol: "XOM",
          price: 110.5,
          provider: "yahoo-finance-delayed",
          delayedFallback: true,
          asOf: "2026-08-18T14:40:00.000Z",
          fetchedAt: "2026-08-18T15:00:00.000Z"
        }
      },
      []
    );
    expect(scan.quotesBySymbol.XOM?.delayedFallback).toBe(true);
    expect(scan.quotesBySymbol.XOM?.provider).toBe("yahoo-finance-delayed");
    expect(scan.source).toBe("yahoo-finance-delayed");
  });

  it("warns when nothing priced", () => {
    const scan = buildApprovalQuoteScan({}, []);
    expect(scan.returnedQuotes).toBe(0);
    expect(scan.warnings[0]).toMatch(/No live quotes/);
  });
});

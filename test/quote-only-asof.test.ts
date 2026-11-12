/**
 * Board 009b99f0: toQuoteOnlyMarketQuote must carry Yahoo's observation time.
 * A wall-clock stamp makes the staleness gate read ~0s old.
 */
import { describe, expect, it } from "vitest";
import { toQuoteOnlyMarketQuote } from "../src/lib/market";
import type { YahooFinanceQuote } from "../src/lib/yahoo-finance";

const INPUT_AS_OF = "2026-08-15T14:00:00.000Z";

function yahooQuote(asOf?: string): YahooFinanceQuote {
  return {
    price: 100,
    bid: 99.9,
    ask: 100.1,
    volume: 1_000_000,
    prevClose: 99,
    ...(asOf !== undefined ? { asOf } : {})
  };
}

describe("toQuoteOnlyMarketQuote asOf", () => {
  it("keeps the Yahoo observation timestamp instead of stamping now", () => {
    const now = Date.now();
    const quote = toQuoteOnlyMarketQuote("AAPL", yahooQuote(INPUT_AS_OF), []);
    expect(quote.asOf).toBe(INPUT_AS_OF);
    const stamped = Date.parse(quote.asOf ?? "");
    expect(Number.isFinite(stamped)).toBe(true);
    expect(now - stamped).toBeGreaterThan(60 * 60 * 1000);
  });

  it("leaves asOf undefined when Yahoo reported no regularMarketTime", () => {
    const quote = toQuoteOnlyMarketQuote("AAPL", yahooQuote(), []);
    expect(quote.asOf).toBeUndefined();
  });
});

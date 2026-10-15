/**
 * One observation-price case per quote provider.
 * Last print, then a two-sided mid.  A size, a prior close, and the wall
 * clock are never the price or the timestamp.
 */
import { describe, expect, it } from "vitest";
import { parseAlpacaSnapshot, parseNasdaqQuoteInfo, parseWebullUnofficialQuote, twelveDataObservedPrice } from "../src/lib/data-providers";
import { etoroQuoteFromRate } from "../src/lib/etoro";
import { kalshiQuoteFromMarket } from "../src/lib/kalshi-broker";
import { readAlpacaStockSnapshotPrice } from "../src/lib/keyless-options-enrichment";
import { toQuoteOnlyMarketQuote } from "../src/lib/market";
import { publicQuoteFromRow } from "../src/lib/public-broker";
import { isQuoteFresh, parseFinnhubQuote, parseTiingoIexQuote, roicProfileQuote } from "../src/lib/quotes-cascade";
import { providerObservationIso, selectObservedQuotePrice } from "../src/lib/quote-observation";
import { parseRobinhoodQuotes } from "../src/lib/robinhood";
import type { YahooFinanceQuote } from "../src/lib/yahoo-finance";

describe("quote observation helpers", () => {
  it("selects last, then the two-sided mid, and never invents a timestamp", () => {
    expect(selectObservedQuotePrice({ last: 10, bid: 9, ask: 11 }).price).toBe(10);
    expect(selectObservedQuotePrice({ bid: 9, ask: 11 })).toEqual({ price: 10, basis: "mid" });
    expect(selectObservedQuotePrice({ ask: 11 })).toEqual({});
    expect(selectObservedQuotePrice({ last: 0, bid: 9 })).toEqual({});
    expect(providerObservationIso(undefined)).toBeUndefined();
    expect(providerObservationIso("not-a-date")).toBeUndefined();
    const old = "2020-01-02T00:00:00.000Z";
    expect(providerObservationIso(old)).toBe(old);
    expect(Date.now() - Date.parse(providerObservationIso(old) ?? "")).toBeGreaterThan(60 * 60 * 1000);
  });
});

describe("provider quote observation", () => {
  it("Alpaca snapshot uses the last print, not the daily close or the trade size", () => {
    const parsed = parseAlpacaSnapshot({
      latestTrade: { p: 50, t: "2026-08-15T14:00:00Z" },
      latestQuote: { bp: 40, ap: 60, bs: 50, as: 50 },
      dailyBar: { c: 49 },
      prevDailyBar: { c: 48 }
    });
    expect(parsed.price).toBe(50);
    expect(parsed.price).not.toBe(12);
    expect(parsed.asOf).toBe("2026-08-15T14:00:00Z");
    expect(parseAlpacaSnapshot({ dailyBar: { c: 49, t: "2026-08-15T00:00:00Z" }, prevDailyBar: { c: 48 } }).price).toBeUndefined();
  });

  it("Alpaca stock snapshot price ignores a previous close and a trade size", () => {
    expect(readAlpacaStockSnapshotPrice({ latestTrade: { p: 20, s: 4 }, dailyBar: { c: 19 }, prevDailyBar: { c: 18 } })).toBe(20);
    expect(readAlpacaStockSnapshotPrice({ prevDailyBar: { c: 18 }, dailyBar: { c: 19 } })).toBeUndefined();
  });

  it("Robinhood uses last, then mid, and does not stamp a missing venue time", () => {
    const quotes = parseRobinhoodQuotes({
      results: [
        { symbol: "AAPL", last_trade_price: "190", previous_close: "400", bid_size: 190, venue_last_trade_time: "2026-08-15T14:00:00Z" },
        { symbol: "MSFT", previous_close: "400", bid_size: 400 },
        { symbol: "IBM", bid_price: "10", ask_price: "12" }
      ]
    });
    expect(quotes.AAPL?.price).toBe(190);
    expect(quotes.AAPL?.asOf).toBe("2026-08-15T14:00:00Z");
    expect(quotes.MSFT?.price).toBeUndefined();
    expect(quotes.MSFT?.asOf).toBeUndefined();
    expect(quotes.IBM?.price).toBe(11);
    expect(quotes.IBM?.asOf).toBeUndefined();
  });

  it("Yahoo quote rows keep the quote price and the Yahoo observation time", () => {
    const yahoo: YahooFinanceQuote = {
      price: 100,
      bid: 99,
      ask: 101,
      volume: 1,
      prevClose: 90,
      asOf: "2026-08-15T14:00:00.000Z"
    };
    const quote = toQuoteOnlyMarketQuote("AAPL", yahoo, []);
    expect(quote.price).toBe(100);
    expect(quote.price).not.toBe(90);
    expect(quote.asOf).toBe("2026-08-15T14:00:00.000Z");
  });

  it("Tiingo uses last, then mid, and leaves asOf unset when the row has no timestamp", () => {
    const last = parseTiingoIexQuote("AAPL", {
      tngoLast: 20,
      bidPrice: 10,
      askPrice: 30,
      bidSize: 20,
      prevClose: 19,
      timestamp: "2026-08-15T14:00:00.000Z"
    });
    expect(last?.price).toBe(20);
    expect(last?.price).not.toBe(19);
    expect(last?.asOf).toBe("2026-08-15T14:00:00.000Z");
    expect(last?.fetchedAt).toBeUndefined();
    const mid = parseTiingoIexQuote("MSFT", { bidPrice: 10, askPrice: 12, prevClose: 40, bidSize: 11 });
    expect(mid?.price).toBe(11);
    expect(mid?.asOf).toBeUndefined();
    expect(parseTiingoIexQuote("XOM", { prevClose: 40, bidSize: 40 })).toBeUndefined();
  });

  it("Nasdaq uses lastSalePrice and does not invent an observation time", () => {
    const parsed = parseNasdaqQuoteInfo({
      data: { primaryData: { lastSalePrice: "$12.50", volume: "9000000" } }
    });
    expect(parsed.price).toBe(12.5);
    expect(parsed.price).not.toBe(9000000);
    expect(parsed.asOf).toBeUndefined();
  });

  it("Webull uses last, then mid, and ignores the prior close", () => {
    const last = parseWebullUnofficialQuote({ lastPrice: 15, preClose: 14, bid: 10, ask: 20, volume: 15 });
    expect(last.price).toBe(15);
    expect(last.asOf).toBeUndefined();
    const mid = parseWebullUnofficialQuote({ bid: 10, ask: 12, preClose: 40, quoteTime: "2026-08-15T14:00:00Z" });
    expect(mid.price).toBe(11);
    expect(mid.asOf).toBe("2026-08-15T14:00:00Z");
    expect(parseWebullUnofficialQuote({ preClose: 40, volume: 40 }).price).toBeUndefined();
    const currentClose = parseWebullUnofficialQuote({ close: 205.5, preClose: 203.2 });
    expect(currentClose.price).toBe(205.5);
  });

  it("Public uses last, then mid, and drops a one-sided book", () => {
    const last = publicQuoteFromRow({ symbol: "AAPL", last: 30, bid: 10, ask: 50, lastTimestamp: "2026-08-15T14:00:00Z" });
    expect(last?.price).toBe(30);
    expect(last?.asOf).toBe("2026-08-15T14:00:00Z");
    expect(publicQuoteFromRow({ symbol: "MSFT", ask: 50, close: 40 })).toBeUndefined();
    expect(publicQuoteFromRow({ symbol: "IBM", bid: 10, ask: 12 })?.price).toBe(11);
  });

  it("eToro uses last execution, then mid, and keeps the rate date", () => {
    const last = etoroQuoteFromRate("AAPL", { lastExecution: 30, bid: 10, ask: 50, date: "2026-08-15T14:00:00Z" });
    expect(last?.price).toBe(30);
    expect(last?.asOf).toBe("2026-08-15T14:00:00Z");
    expect(etoroQuoteFromRate("MSFT", { ask: 50 })).toBeUndefined();
    expect(etoroQuoteFromRate("IBM", { bid: 10, ask: 12 })?.price).toBe(11);
    expect(etoroQuoteFromRate("IBM", { bid: 10, ask: 12 })?.asOf).toBeUndefined();
  });

  it("Kalshi uses last, then mid, and does not invent 0.5 or an observation time", () => {
    const last = kalshiQuoteFromMarket({ ticker: "KX", last_price: 70, yes_bid: 30, yes_ask: 50 });
    expect(last?.price).toBe(0.7);
    expect(last?.price).not.toBe(0.5);
    expect(last?.asOf).toBeUndefined();
    expect(last?.venuePriceAuthoritative).toBeUndefined();
    expect(kalshiQuoteFromMarket({ ticker: "KX2", yes_ask: 50 })).toBeUndefined();
    expect(kalshiQuoteFromMarket({ ticker: "KX3", yes_bid: 20, yes_ask: 40 })?.price).toBeCloseTo(0.3, 10);
  });

  it("ROIC profile prices have no observation time and are not fresh", () => {
    const quote = roicProfileQuote("AAPL", { price: 100, companyName: "Apple" });
    expect(quote?.price).toBe(100);
    expect(quote?.asOf).toBeUndefined();
    expect(isQuoteFresh(quote ?? {}, Date.now(), 120_000)).toBe(false);
  });

  it("Twelve Data uses last, then close, and never previous_close or volume", () => {
    expect(twelveDataObservedPrice({ last: 10, close: 9, previous_close: 8, volume: 1_000_000 })).toBe(10);
    expect(twelveDataObservedPrice({ close: 9, previous_close: 8, volume: 9 })).toBe(9);
    expect(twelveDataObservedPrice({ previous_close: 8, volume: 8 })).toBeUndefined();
  });

  it("Finnhub uses the current price and not the previous close", () => {
    const quote = parseFinnhubQuote("AAPL", { c: 11, pc: 10, t: 1582641000 });
    expect(quote?.price).toBe(11);
    expect(quote?.prevClose).toBe(10);
    expect(quote?.asOf).toBe(new Date(1582641000 * 1000).toISOString());
    expect(parseFinnhubQuote("MSFT", { pc: 10 })?.price).toBeUndefined();
    expect(parseFinnhubQuote("IBM", { c: 11 })?.asOf).toBeUndefined();
  });
});

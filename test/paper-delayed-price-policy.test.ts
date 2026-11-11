import { describe, expect, it } from "vitest";
import { preferFreshQuote } from "../app/console/ui/drilldown-data";
import {
  alignBrokerQuoteRecord,
  choosePaperPrice,
  paperDelayedPricePolicy,
  PAPER_DELAYED_PRICE_LABEL,
  PAPER_DELAYED_PRICE_NOTE,
  type DelayablePrice
} from "../src/lib/paper-delayed-price-policy";
import type { MarketQuote } from "../src/lib/types";

const NOW = Date.parse("2026-11-11T15:30:00.000Z");
const ALPACA_AS_OF = "2026-11-11T15:14:40.000Z";

const paper = paperDelayedPricePolicy({ broker: "alpaca", environment: "paper" }, NOW);
const live = paperDelayedPricePolicy({ broker: "alpaca", environment: "live" }, NOW);
const tradier = paperDelayedPricePolicy({ broker: "tradier", environment: "paper" }, NOW);

function quote(partial: Partial<MarketQuote>): MarketQuote {
  return {
    symbol: "AAPL",
    price: 100,
    volume: 1,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 1,
    ...partial
  };
}

describe("paperDelayedPricePolicy", () => {
  it("is active only for an Alpaca paper account", () => {
    expect(paper.active).toBe(true);
    expect(paper.label).toBe(PAPER_DELAYED_PRICE_LABEL);
    expect(PAPER_DELAYED_PRICE_NOTE).toBe("Prices are generally 15-min delayed.");
    expect(live.active).toBe(false);
    expect(live.asOf).toBeUndefined();
    expect(tradier.active).toBe(false);
    expect(paperDelayedPricePolicy({ broker: "alpaca-mcp", environment: "paper" }, NOW).active).toBe(false);
  });

  it("keeps Alpaca's timestamp and keeps a fallback when Alpaca has no price", () => {
    const yahooAsOf = new Date(NOW - 20_000).toISOString();
    const screenerAsOf = "2026-11-11";
    const rows: Record<string, DelayablePrice & { symbol: string }> = {
      SIP: { symbol: "SIP", price: 10, asOf: ALPACA_AS_OF, provider: "alpaca", expectedDelaySec: 900 },
      YAHOO: { symbol: "YAHOO", price: 11, asOf: yahooAsOf, provider: "yahoo-finance" },
      SCREEN: { symbol: "SCREEN", price: 12, asOf: screenerAsOf, provider: "nasdaq-delayed-screener" }
    };

    const delayed = alignBrokerQuoteRecord(rows, paper);
    expect(delayed.SIP?.price).toBe(10);
    expect(delayed.SIP?.asOf).toBe(ALPACA_AS_OF);
    expect(delayed.SIP?.priceDelayLabel).toBe("15-min delayed");
    expect(delayed.YAHOO?.price).toBe(11);
    expect(delayed.YAHOO?.asOf).toBe(yahooAsOf);
    expect(delayed.YAHOO?.priceDelayLabel).toBeUndefined();
    expect(delayed.SCREEN?.price).toBe(12);
    expect(delayed.SCREEN?.asOf).toBe(screenerAsOf);
    expect(delayed.SCREEN?.priceDelayLabel).toBeUndefined();

    const untouched = alignBrokerQuoteRecord(rows, live);
    expect(untouched.SIP?.asOf).toBe(ALPACA_AS_OF);
    expect(untouched.YAHOO?.asOf).toBe(yahooAsOf);
    expect(untouched.YAHOO?.priceDelayLabel).toBeUndefined();
    expect(untouched.SCREEN?.asOf).toBe(screenerAsOf);
  });

  it("prefers the Alpaca delayed quote and keeps a fresher fallback when Alpaca is missing", () => {
    const sip = {
      price: 180,
      asOf: ALPACA_AS_OF,
      provider: "alpaca",
      expectedDelaySec: 900
    };
    const yahoo = { price: 181.5, asOf: new Date(NOW - 5_000).toISOString(), provider: "yahoo-finance" };
    const chosen = choosePaperPrice([yahoo, sip], paper);
    expect(chosen.source).toBe("delayed_sip");
    expect(chosen.price).toBe(180);
    expect(chosen.asOf).toBe(ALPACA_AS_OF);
    expect(chosen.priceDelayLabel).toBe("15-min delayed");
    expect(chosen.withheld).toBe(false);

    const freshOnly = choosePaperPrice([yahoo], paper);
    expect(freshOnly.source).toBe("fallback");
    expect(freshOnly.price).toBe(181.5);
    expect(freshOnly.asOf).toBe(yahoo.asOf);
    expect(freshOnly.priceDelayLabel).toBeUndefined();
    expect(freshOnly.withheld).toBe(false);

    const passthrough = choosePaperPrice([yahoo, sip], live);
    expect(passthrough.source).toBe("passthrough");
    expect(passthrough.price).toBe(181.5);
    expect(passthrough.asOf).toBe(yahoo.asOf);
    expect(passthrough.priceDelayLabel).toBeUndefined();
  });

  it("does not stamp a fallback with Alpaca's clock", () => {
    const olderAsOf = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const older = choosePaperPrice(
      [{ price: 50, asOf: olderAsOf, provider: "yahoo-finance" }],
      paper
    );
    expect(older.source).toBe("fallback");
    expect(older.price).toBe(50);
    expect(older.asOf).toBe(olderAsOf);
    expect(older.priceDelayLabel).toBeUndefined();

    const screener = choosePaperPrice(
      [{ price: 12, asOf: "2026-11-11", provider: "nasdaq-delayed-screener" }],
      paper
    );
    expect(screener.source).toBe("fallback");
    expect(screener.asOf).toBe("2026-11-11");
    expect(screener.priceDelayLabel).toBeUndefined();
  });

  it("keeps a delayed quote when a newer unlabelled quote is also available", () => {
    const delayed = quote({ price: 10, asOf: ALPACA_AS_OF, priceDelayLabel: "15-min delayed" });
    const fresh = quote({ price: 11, asOf: new Date(NOW).toISOString() });
    expect(preferFreshQuote(fresh, delayed)?.price).toBe(10);
    expect(preferFreshQuote(delayed, fresh)?.price).toBe(10);
  });
});

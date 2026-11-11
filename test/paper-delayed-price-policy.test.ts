import { describe, expect, it } from "vitest";
import { preferFreshQuote } from "../app/console/ui/drilldown-data";
import {
  ALPACA_PAPER_EXPECTED_DELAY_SEC
} from "../src/lib/alpaca-paper-quotes";
import {
  alignBrokerQuoteRecord,
  choosePaperPrice,
  paperDelayedPricePolicy,
  PAPER_DELAYED_PRICE_LABEL,
  type DelayablePrice,
  type PaperDelayedPricePolicy
} from "../src/lib/paper-delayed-price-policy";
import type { MarketQuote } from "../src/lib/types";

const NOW = Date.parse("2026-11-11T15:30:00.000Z");
const CANONICAL = new Date(NOW - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000).toISOString();

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
  it("is active only for an Alpaca paper account and stamps one 15-minute as-of", () => {
    expect(paper.active).toBe(true);
    expect(paper.asOf).toBe(CANONICAL);
    expect(paper.label).toBe(PAPER_DELAYED_PRICE_LABEL);
    expect(paper.label).toBe("15-min delayed");
    expect(live.active).toBe(false);
    expect(live.asOf).toBeUndefined();
    expect(tradier.active).toBe(false);
    expect(paperDelayedPricePolicy({ broker: "alpaca-mcp", environment: "paper" }, NOW).active).toBe(false);
  });

  it("gives a paper batch one shared as-of and leaves a live batch on its own clocks", () => {
    const sipAsOf = new Date(NOW - 900_000 + 30_000).toISOString();
    const yahooAsOf = new Date(NOW - 20_000).toISOString();
    const screenerAsOf = "2026-11-11";
    const rows: Record<string, DelayablePrice & { symbol: string }> = {
      SIP: { symbol: "SIP", price: 10, asOf: sipAsOf, provider: "alpaca", expectedDelaySec: 900 },
      YAHOO: { symbol: "YAHOO", price: 11, asOf: yahooAsOf, provider: "yahoo-finance" },
      SCREEN: { symbol: "SCREEN", price: 12, asOf: screenerAsOf, provider: "nasdaq-delayed-screener" }
    };

    const delayed = alignBrokerQuoteRecord(rows, paper);
    expect(delayed.SIP?.price).toBe(10);
    expect(delayed.SIP?.asOf).toBe(paper.asOf);
    expect(delayed.SIP?.priceDelayLabel).toBe("15-min delayed");
    expect(delayed.SCREEN?.price).toBe(12);
    expect(delayed.SCREEN?.asOf).toBe(paper.asOf);
    expect(delayed.YAHOO).toBeUndefined();

    const untouched = alignBrokerQuoteRecord(rows, live);
    expect(untouched.SIP?.asOf).toBe(sipAsOf);
    expect(untouched.YAHOO?.asOf).toBe(yahooAsOf);
    expect(untouched.YAHOO?.priceDelayLabel).toBeUndefined();
    expect(untouched.SCREEN?.asOf).toBe(screenerAsOf);
  });

  it("prefers delayed_sip over a fresher print and withholds a fresher-only symbol", () => {
    const sip = {
      price: 180,
      asOf: new Date(NOW - 890_000).toISOString(),
      provider: "alpaca",
      expectedDelaySec: 900
    };
    const yahoo = { price: 181.5, asOf: new Date(NOW - 5_000).toISOString(), provider: "yahoo-finance" };
    const chosen = choosePaperPrice([yahoo, sip], paper);
    expect(chosen.source).toBe("delayed_sip");
    expect(chosen.price).toBe(180);
    expect(chosen.asOf).toBe(paper.asOf);
    expect(chosen.withheld).toBe(false);

    const freshOnly = choosePaperPrice([yahoo], paper);
    expect(freshOnly.source).toBe("withheld");
    expect(freshOnly.price).toBeUndefined();
    expect(freshOnly.asOf).toBe(paper.asOf);

    const passthrough = choosePaperPrice([yahoo, sip], live);
    expect(passthrough.source).toBe("passthrough");
    expect(passthrough.price).toBe(181.5);
    expect(passthrough.asOf).toBe(yahoo.asOf);
    expect(passthrough.priceDelayLabel).toBeUndefined();
  });

  it("rewinds to the bar inside the window and keeps an older print's real as-of", () => {
    const olderAsOf = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const older = choosePaperPrice(
      [{ price: 50, asOf: olderAsOf, provider: "yahoo-finance" }],
      paper
    );
    expect(older.source).toBe("older");
    expect(older.price).toBe(50);
    expect(older.asOf).toBe(olderAsOf);
    expect(older.priceDelayLabel).toBe("15-min delayed");

    const rewound = choosePaperPrice(
      [{ price: 99, asOf: new Date(NOW - 5_000).toISOString(), provider: "yahoo-finance" }],
      paper,
      [
        { timeMs: NOW - 20 * 60 * 1000, price: 40 },
        { timeMs: NOW - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000, price: 42 },
        { timeMs: NOW - 60_000, price: 44 }
      ]
    );
    expect(rewound.source).toBe("rewound");
    expect(rewound.price).toBe(42);
    expect(rewound.asOf).toBe(paper.asOf);
  });

  it("shares one as-of across two symbols that both land in the window", () => {
    const policy: PaperDelayedPricePolicy = paper;
    const a = choosePaperPrice(
      [{ price: 1, asOf: new Date(NOW - 900_000 + 10_000).toISOString(), expectedDelaySec: 900 }],
      policy
    );
    const b = choosePaperPrice(
      [{ price: 2, asOf: new Date(NOW - 900_000 - 20_000).toISOString(), provider: "nasdaq-delayed-screener" }],
      policy
    );
    expect(a.asOf).toBe(b.asOf);
    expect(a.asOf).toBe(policy.asOf);
  });

  it("keeps a delayed quote when a newer unlabelled quote is also available", () => {
    const delayed = quote({ price: 10, asOf: CANONICAL, priceDelayLabel: "15-min delayed" });
    const fresh = quote({ price: 11, asOf: new Date(NOW).toISOString() });
    expect(preferFreshQuote(fresh, delayed)?.price).toBe(10);
    expect(preferFreshQuote(delayed, fresh)?.price).toBe(10);
  });
});

import { describe, expect, it } from "vitest";
import {
  composeOnDemandQuote,
  enrichmentHasValues,
  fastQuoteEnrichment,
  mergeOnDemandEnrichment
} from "../src/lib/on-demand-quote";

describe("fastQuoteEnrichment", () => {
  it("maps chart-floor 52-week range when Yahoo actually returned it", () => {
    const enrichment = fastQuoteEnrichment({
      companyName: "Alphabet Inc.",
      price: 343.94,
      bid: 343.6,
      ask: 344.3,
      prevClose: 342.37,
      volume: 14_897_228,
      asOf: "2026-08-13T20:00:00.000Z",
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46,
      syntheticBid: true,
      syntheticAsk: true,
      syntheticSpread: true
    });
    expect(enrichment).toMatchObject({
      companyName: "Alphabet Inc.",
      price: 343.94,
      volume: 14_897_228,
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46,
      sources: {
        companyName: "yahoo-finance",
        price: "yahoo-finance",
        fiftyTwoWeekHigh: "yahoo-finance",
        fiftyTwoWeekLow: "yahoo-finance"
      }
    });
    expect(enrichment.peRatio).toBeUndefined();
    expect(enrichment.bid).toBeUndefined();
    expect(enrichment.ask).toBeUndefined();
  });
});

describe("composeOnDemandQuote", () => {
  it("keeps durable PE when live layers omit it, and lets a newer live price win", () => {
    const composed = composeOnDemandQuote([
      { peRatio: 26.4, eps: 8.12, sources: { peRatio: "symbol-field-latest" } },
      {
        price: 343.94,
        volume: 14_897_228,
        asOf: "2026-08-13T20:00:00.000Z",
        sources: { price: "yahoo-finance", volume: "yahoo-finance" }
      },
      { peRatio: 27.1, sources: { peRatio: "yahoo-finance" } }
    ]);
    expect(composed).toMatchObject({
      price: 343.94,
      volume: 14_897_228,
      peRatio: 27.1,
      eps: 8.12,
      sources: {
        price: "yahoo-finance",
        peRatio: "yahoo-finance"
      }
    });
  });

  it("does not let an older rich price erase a newer chart floor", () => {
    const merged = mergeOnDemandEnrichment(
      {
        price: 343.94,
        asOf: "2026-08-13T20:01:00.000Z",
        sources: { price: "yahoo-finance", asOf: "yahoo-finance" }
      },
      {
        price: 340,
        asOf: "2026-08-13T19:00:00.000Z",
        sources: { price: "alpaca", asOf: "alpaca" }
      }
    );
    expect(merged.price).toBe(343.94);
    expect(merged.sources?.price).toBe("yahoo-finance");
  });

  it("treats only real values as a durable seed", () => {
    expect(enrichmentHasValues({})).toBe(false);
    expect(enrichmentHasValues({ sources: { peRatio: "yahoo-finance" } })).toBe(false);
    expect(enrichmentHasValues({ peRatio: 26.4 })).toBe(true);
  });
});

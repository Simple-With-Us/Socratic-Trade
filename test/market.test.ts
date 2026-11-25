import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { applyEnrichment, attachBarDerivedFields, barDerivedFieldsBySymbol, buildRotatingTechnicalWatchlist, hasNotableWebSignal, mergeGroupedBarData, mergeQuoteData, outlierInterestScore, persistedSlowEnrichment, quotesBySymbol, rankMarketQuotes, scoreFactors } from "../src/lib/market";
import { barDerivedQuoteFields, type BarDerivedQuoteFields } from "../src/lib/bar-quote-fields";
import { atr, type OHLCBar } from "../src/lib/indicators";
import { fetchHistoryCacheEodBulk, upsertHistoryCacheEod } from "../src/lib/history-cache";
import { getDb, resetDbForTesting } from "../src/lib/db";
import type { SymbolEnrichment } from "../src/lib/data-providers";
import type { MarketQuote, MarketScan } from "../src/lib/types";

describe("rankMarketQuotes", () => {
  it("prioritizes liquid positive movers without existing exposure", () => {
    const quotes: MarketQuote[] = [
      quote({ symbol: "AAPL", volume: 5_000_000, intradayChangePct: 1, positionMarketValue: 20 }),
      quote({ symbol: "MSFT", volume: 20_000_000, intradayChangePct: 2, positionMarketValue: 0 }),
      quote({ symbol: "XYZ", volume: 10_000, intradayChangePct: -3, positionMarketValue: 0 })
    ];

    expect(rankMarketQuotes(quotes).map((item) => item.symbol)).toEqual(["MSFT", "AAPL", "XYZ"]);
  });

  it("normalizes scoring weights into a transparent factor total", () => {
    const scored = scoreFactors(
      quote({ symbol: "MSFT", volume: 20_000_000, intradayChangePct: 2, positionMarketValue: 0 }),
      { liquidity: 1, momentum: 1, value: 0, quality: 0, volatility: 0, sentiment: 0, positioning: 0, diversification: 0 }
    );

    expect(scored.liquidity).toBeGreaterThan(0);
    expect(scored.momentum).toBeGreaterThan(50);
    expect(scored.weightedTotal).toBeGreaterThan(40);
    expect(scored.weightedTotal).toBeLessThanOrEqual(100);
  });

  it("rewards strong fundamentals in the value and quality sub-scores", () => {
    const common = { marketCap: 2_000_000_000, volume: 2_000_000, peRatio: 30 };
    const weak = scoreFactors(quote({ symbol: "W", ...common, fcfYield: -2, debtToEquity: 350, epsGrowth: -0.2 }));
    const strong = scoreFactors(quote({ symbol: "S", ...common, fcfYield: 8, debtToEquity: 30, epsGrowth: 0.25 }));
    expect(strong.value).toBeGreaterThan(weak.value); // FCF yield lifts value
    expect(strong.quality).toBeGreaterThan(weak.quality); // low leverage + EPS growth lift quality
  });

  it("treats a sec-xbrl D/E above 10 as a true ratio (penalized), not a percentage", () => {
    const common = { marketCap: 2_000_000_000, volume: 2_000_000 };
    // sec-xbrl always emits a true ratio: 12 = 12x leverage → penalized. The `>10 → ÷100` percentage
    // heuristic is source-aware, so it is NOT applied here (otherwise 12 would read as 0.12 and the
    // over-levered name would be wrongly REWARDED as near-debt-free).
    const levered = scoreFactors(quote({ symbol: "L", ...common, debtToEquity: 12, sources: { debtToEquity: "sec-xbrl" } }));
    const safe = scoreFactors(quote({ symbol: "S", ...common, debtToEquity: 0.3, sources: { debtToEquity: "sec-xbrl" } }));
    expect(levered.quality).toBeLessThan(safe.quality);
  });

  it("blends 52-week position into momentum and beta into volatility", () => {
    const nearHigh = scoreFactors(quote({ symbol: "H", intradayChangePct: 1, price: 99, fiftyTwoWeekLow: 50, fiftyTwoWeekHigh: 100 }));
    const nearLow = scoreFactors(quote({ symbol: "L", intradayChangePct: 1, price: 51, fiftyTwoWeekLow: 50, fiftyTwoWeekHigh: 100 }));
    expect(nearHigh.momentum).toBeGreaterThan(nearLow.momentum); // near the 52-week high = stronger momentum

    const highBeta = scoreFactors(quote({ symbol: "HB", intradayChangePct: 0, beta: 1.8 }));
    const lowBeta = scoreFactors(quote({ symbol: "LB", intradayChangePct: 0, beta: 0.6 }));
    expect(lowBeta.volatility).toBeGreaterThan(highBeta.volatility); // high beta scores as riskier (lower stability)
  });
});

describe("positioning sub-score", () => {
  it("lifts net congressional + insider buying and dings net selling", () => {
    const neutral = scoreFactors(quote({ symbol: "N" }));
    const buy = scoreFactors(quote({ symbol: "B", senateTrades: 3, insiderSentiment: 80 }));
    const sell = scoreFactors(quote({ symbol: "S", senateTrades: -2, insiderSentiment: 20 }));
    expect(buy.positioning).toBeGreaterThan(neutral.positioning);
    expect(sell.positioning).toBeLessThan(neutral.positioning);
    expect(neutral.positioning).toBe(50); // no signal => neutral
  });

  it("uses congressCompositeScore signedScore when present and shifts composite ranking", () => {
    const neutral = quote({ symbol: "NEUT", volume: 5_000_000, intradayChangePct: 1 });
    const strongBuy = quote({
      symbol: "CBUY",
      volume: 5_000_000,
      intradayChangePct: 1,
      congressCompositeScore: 85,
      congressCompositeSignedScore: 85,
      congressCompositeDirection: "BUY",
      congressCompositeConfidence: 0.9
    });
    const strongSell = quote({
      symbol: "CSELL",
      volume: 5_000_000,
      intradayChangePct: 1,
      congressCompositeScore: 85,
      congressCompositeSignedScore: -85,
      congressCompositeDirection: "SELL",
      congressCompositeConfidence: 0.9
    });

    const neutralFactors = scoreFactors(neutral);
    const buyFactors = scoreFactors(strongBuy);
    const sellFactors = scoreFactors(strongSell);

    // 85 * 0.18 = 15.3 -> +15 / -15 delta around 50
    expect(buyFactors.positioning).toBe(65);
    expect(sellFactors.positioning).toBe(35);
    expect(buyFactors.weightedTotal).toBeGreaterThan(neutralFactors.weightedTotal);
    expect(sellFactors.weightedTotal).toBeLessThan(neutralFactors.weightedTotal);

    const ranked = rankMarketQuotes([
      { ...strongSell, score: sellFactors.weightedTotal },
      { ...neutral, score: neutralFactors.weightedTotal },
      { ...strongBuy, score: buyFactors.weightedTotal }
    ]);
    expect(ranked.map((q) => q.symbol)).toEqual(["CBUY", "NEUT", "CSELL"]);
  });

  it("bounds congressCompositeScore delta to [-18, +18] and ignores neutral or zero-confidence scores", () => {
    const cappedBuy = scoreFactors(
      quote({
        symbol: "CAPB",
        congressCompositeScore: 100,
        congressCompositeSignedScore: 150,
        congressCompositeDirection: "BUY",
        congressCompositeConfidence: 1
      })
    );
    const cappedSell = scoreFactors(
      quote({
        symbol: "CAPS",
        congressCompositeScore: 100,
        congressCompositeSignedScore: -150,
        congressCompositeDirection: "SELL",
        congressCompositeConfidence: 1
      })
    );
    const zeroConf = scoreFactors(
      quote({
        symbol: "ZCONF",
        congressCompositeScore: 80,
        congressCompositeSignedScore: 80,
        congressCompositeDirection: "BUY",
        congressCompositeConfidence: 0
      })
    );
    const undefConf = scoreFactors(
      quote({
        symbol: "UCONF",
        congressCompositeScore: 80,
        congressCompositeSignedScore: 80,
        congressCompositeDirection: "BUY"
      })
    );
    const neutralDir = scoreFactors(
      quote({
        symbol: "NDIR",
        congressCompositeScore: 80,
        congressCompositeSignedScore: 80,
        congressCompositeDirection: "NEUTRAL",
        congressCompositeConfidence: 0.8
      })
    );
    const mismatchedBuyWithNegSigned = scoreFactors(
      quote({
        symbol: "MISBUY",
        congressCompositeScore: 80,
        congressCompositeSignedScore: -80,
        congressCompositeDirection: "BUY",
        congressCompositeConfidence: 0.8
      })
    );
    const mismatchedSellWithPosSigned = scoreFactors(
      quote({
        symbol: "MISSELL",
        congressCompositeScore: 80,
        congressCompositeSignedScore: 80,
        congressCompositeDirection: "SELL",
        congressCompositeConfidence: 0.8
      })
    );

    expect(cappedBuy.positioning).toBe(68);
    expect(cappedSell.positioning).toBe(32);
    expect(zeroConf.positioning).toBe(50);
    expect(undefConf.positioning).toBe(50);
    expect(neutralDir.positioning).toBe(50);
    // 80 * 0.18 = 14.4 -> 14. Reconciled to positive for BUY direction: 50 + 14 = 64
    expect(mismatchedBuyWithNegSigned.positioning).toBe(64);
    // Reconciled to negative for SELL direction: 50 - 14 = 36
    expect(mismatchedSellWithPosSigned.positioning).toBe(36);
  });

  it("supports object congressCompositeScore without signedScore by reconciling score and direction", () => {
    const buyObj = scoreFactors(
      quote({
        symbol: "BOBJ",
        congressCompositeScore: {
          score: 80,
          direction: "BUY",
          confidence: 0.9
        } as unknown as number
      })
    );
    const sellObj = scoreFactors(
      quote({
        symbol: "SOBJ",
        congressCompositeScore: {
          score: 80,
          direction: "SELL",
          confidence: 0.9
        } as unknown as number
      })
    );
    const neutralObj = scoreFactors(
      quote({
        symbol: "NOBJ",
        congressCompositeScore: {
          score: 80,
          direction: "NEUTRAL",
          confidence: 0.9
        } as unknown as number
      })
    );
    const directionlessObj = scoreFactors(
      quote({
        symbol: "DLSOBJ",
        congressCompositeScore: {
          score: 80,
          confidence: 0.9
        } as unknown as number
      })
    );
    expect(buyObj.positioning).toBe(50 + 14); // Math.round(80 * 0.18) = 14
    expect(sellObj.positioning).toBe(50 - 14); // -14
    expect(neutralObj.positioning).toBe(50);
    expect(directionlessObj.positioning).toBe(50); // directionless stays neutral
  });
});

describe("hasNotableWebSignal (event candidate union)", () => {
  it("flags net congressional buys (≥2 members, netSignal≥2), insider buying, and elevated short pressure", () => {
    // Congress: both buyCount AND netSignal must reach the floor.
    expect(hasNotableWebSignal({ congress: { netSignal: 2, buyCount: 2 } as never, bulletins: [] })).toBe(true);
    expect(hasNotableWebSignal({ congress: { netSignal: 3, buyCount: 4 } as never, bulletins: [] })).toBe(true);
    expect(hasNotableWebSignal({ insiderSentiment: 80, bulletins: [] })).toBe(true);
    expect(hasNotableWebSignal({ shortVolumeRatio: 62, bulletins: [] })).toBe(true);
  });
  it("does not flag thin congress signals (single member or netSignal < 2)", () => {
    // netSignal=1: only 1 more buyer than seller — not enough on its own
    expect(hasNotableWebSignal({ congress: { netSignal: 1, buyCount: 1 } as never, bulletins: [] })).toBe(false);
    // buyCount=1 even with netSignal=2 — single member, too thin
    expect(hasNotableWebSignal({ congress: { netSignal: 2, buyCount: 1 } as never, bulletins: [] })).toBe(false);
    // net selling
    expect(hasNotableWebSignal({ congress: { netSignal: -1, buyCount: 1 } as never, bulletins: [] })).toBe(false);
  });
  it("does not flag neutral insider, ordinary short volume, or undefined", () => {
    expect(hasNotableWebSignal({ insiderSentiment: 40, shortVolumeRatio: 45, bulletins: [] })).toBe(false);
    expect(hasNotableWebSignal(undefined)).toBe(false);
  });

  it("requires strong supported BUY analytics before promoting a Congress.Trade outlier", () => {
    expect(hasNotableWebSignal({
      bulletins: [],
      congressAnalytics: { convictionScore: 100, convictionDirection: "BUY", convictionFallback: true }
    })).toBe(false);
    expect(hasNotableWebSignal({
      bulletins: [],
      congressAnalytics: { convictionScore: 90, convictionDirection: "SELL", netFlowUsd: -1_000_000, memberCount: 3 }
    })).toBe(false);
    expect(hasNotableWebSignal({
      bulletins: [],
      congressAnalytics: { convictionScore: 85, convictionDirection: "BUY", netFlowUsd: 1_000_000, memberCount: 3, tradeCount: 4, cluster: true, topMemberScore: 90 }
    })).toBe(true);
  });

  it("scores stronger below-cutoff outlier signals ahead of weaker ones", () => {
    const thinInsider = outlierInterestScore({ insiderSentiment: 61, bulletins: [] });
    const broadCongressBuying = outlierInterestScore({ congress: { netSignal: 3, buyCount: 4 } as never, bulletins: [] });

    expect(thinInsider).toBeGreaterThan(0);
    expect(broadCongressBuying).toBeGreaterThan(thinInsider);
  });
});

describe("applyEnrichment", () => {
  it("folds every enriched field (incl. fcf/leverage/growth/congress) onto the quote", () => {
    // Regression: these four used to be dropped by the scan merge, so scoring/prompt/UI
    // never saw them even when a provider supplied real values.
    const extra: SymbolEnrichment = {
      fcfYield: 7.5,
      debtToEquity: 0.4,
      epsGrowth: 0.22,
      senateTrades: 3,
      insiderSentiment: 80,
      peRatio: 18,
      sector: "Technology",
      sources: { fcfYield: "yahoo-finance", senateTrades: "congress-trades" }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.fcfYield).toBe(7.5);
    expect(enriched.debtToEquity).toBe(0.4);
    expect(enriched.epsGrowth).toBe(0.22);
    expect(enriched.senateTrades).toBe(3);
    expect(enriched.insiderSentiment).toBe(80);
    expect(enriched.sources?.fcfYield).toBe("yahoo-finance");
    expect(enriched.sources?.senateTrades).toBe("congress-trades");
  });

  it("folds the newly arbitrated quote fields (bidSize/askSize/prevClose/OHLC/netChange) onto the quote", () => {
    // Codex P1 review on #3449: providers supply these, the cascade arbitrates
    // them, and applyEnrichment must carry them onto the MarketQuote.
    const extra: SymbolEnrichment = {
      bidSize: 100,
      askSize: 200,
      prevClose: 148,
      open: 149,
      high: 151,
      low: 147.5,
      netChange: 2.5
    };
    const enriched = applyEnrichment(quote({ symbol: "AAPL" }), extra);
    expect(enriched.bidSize).toBe(100);
    expect(enriched.askSize).toBe(200);
    expect(enriched.prevClose).toBe(148);
    expect(enriched.open).toBe(149);
    expect(enriched.high).toBe(151);
    expect(enriched.low).toBe(147.5);
    expect(enriched.netChange).toBe(2.5);
  });

  it("carries the delayed-tape metadata onto the quote so a ~900s print is not realtime-stale", () => {
    // Kody review on PR #5005: the account-scoped `delayed_sip` enrichment must
    // reach the scan quote with its tape metadata, otherwise the staleness
    // gate reads the ~900s-old print as a stale realtime observation.
    const extra: SymbolEnrichment = {
      price: 195.5,
      asOf: "2026-11-05T19:45:00.000Z",
      expectedDelaySec: 900,
      delayToleranceSec: 120,
      venuePriceAuthoritative: true,
      fetchedAt: "2026-11-05T20:00:00.000Z"
    };
    const enriched = applyEnrichment(quote({ symbol: "AAPL" }), extra);
    expect(enriched.expectedDelaySec).toBe(900);
    expect(enriched.delayToleranceSec).toBe(120);
    expect(enriched.venuePriceAuthoritative).toBe(true);
    // The RETRIEVAL stamp travels with it so the quote ages by fetch time.
    expect(enriched.fetchedAt).toBe("2026-11-05T20:00:00.000Z");
  });

  it("leaves a realtime enrichment without tape metadata", () => {
    const enriched = applyEnrichment(quote({ symbol: "AAPL" }), { price: 195.5 });
    expect(enriched.expectedDelaySec).toBeUndefined();
    expect(enriched.delayToleranceSec).toBeUndefined();
    expect(enriched.venuePriceAuthoritative).toBeUndefined();
    expect(enriched.fetchedAt).toBeUndefined();
  });

  it("keeps the existing quote value when enrichment omits a field", () => {
    const enriched = applyEnrichment(quote({ symbol: "AAPL", senateTrades: 2 }), { peRatio: 30 });
    expect(enriched.senateTrades).toBe(2); // not clobbered by undefined
    expect(enriched.peRatio).toBe(30);
  });

  it("folds the new data-breadth fields (earnings, institution ownership, options IV) onto the quote", () => {
    const extra: SymbolEnrichment = {
      daysToEarnings: 8,
      institutionOwnershipPct: 61.5,
      nearTheMoneyIv: 34,
      putCallRatio: 0.9,
      sources: {
        daysToEarnings: "yahoo-finance",
        institutionOwnershipPct: "yahoo-finance",
        nearTheMoneyIv: "robinhood-options",
        putCallRatio: "robinhood-options"
      }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.daysToEarnings).toBe(8);
    expect(enriched.institutionOwnershipPct).toBe(61.5);
    expect(enriched.nearTheMoneyIv).toBe(34);
    expect(enriched.putCallRatio).toBe(0.9);
    expect(enriched.sources?.daysToEarnings).toBe("yahoo-finance");
    expect(enriched.sources?.nearTheMoneyIv).toBe("robinhood-options");
  });

  it("keeps a positive screener market cap when SEC XBRL only derived one", () => {
    const extra: SymbolEnrichment = {
      marketCap: 50_000_000,
      sharesOutstanding: 1_000_000,
      price: 50,
      sources: { marketCap: "sec-xbrl", sharesOutstanding: "sec-xbrl", price: "yahoo-finance" },
      fieldObservations: {
        marketCap: {
          value: 50_000_000,
          source: "sec-xbrl",
          upstreamFamily: "sec-xbrl",
          fetchedAt: "2026-10-14T00:00:00.000Z",
          status: "ok"
        }
      }
    };
    const enriched = applyEnrichment(
      quote({ symbol: "AAPL", marketCap: 3_000_000_000_000, sources: { marketCap: "nasdaq-delayed-screener" } }),
      extra
    );
    expect(enriched.marketCap).toBe(3_000_000_000_000);
    expect(enriched.sources?.marketCap).toBe("nasdaq-delayed-screener");
    expect(enriched.fieldObservations?.marketCap).toBeUndefined();
    expect(enriched.sharesOutstanding).toBe(1_000_000);
  });

  it("adopts SEC-derived market cap only when the screener cap is missing", () => {
    const extra: SymbolEnrichment = {
      marketCap: 200_000_000,
      sources: { marketCap: "sec-xbrl" },
      fieldObservations: {
        marketCap: {
          value: 200_000_000,
          source: "sec-xbrl",
          upstreamFamily: "sec-xbrl",
          fetchedAt: "2026-10-14T00:00:00.000Z",
          status: "ok"
        }
      }
    };
    const enriched = applyEnrichment(quote({ symbol: "AAPL" }), extra);
    expect(enriched.marketCap).toBe(200_000_000);
    expect(enriched.sources?.marketCap).toBe("sec-xbrl");
    expect(enriched.fieldObservations?.marketCap?.source).toBe("sec-xbrl");
  });

  it("still lets a non-SEC enrichment market cap override the screener", () => {
    const enriched = applyEnrichment(
      quote({ symbol: "AAPL", marketCap: 1_000 }),
      { marketCap: 2_000_000_000, sources: { marketCap: "yahoo-finance" } }
    );
    expect(enriched.marketCap).toBe(2_000_000_000);
    expect(enriched.sources?.marketCap).toBe("yahoo-finance");
  });

  it("preserves cascade fieldObservations and providerFailures on the quote", () => {
    const extra: SymbolEnrichment = {
      peRatio: 22,
      sources: { peRatio: "yahoo-finance" },
      fieldObservations: {
        peRatio: {
          value: 22,
          source: "yahoo-finance",
          upstreamFamily: "yahoo-finance",
          fetchedAt: "2026-07-26T00:00:00.000Z",
          status: "ok"
        }
      },
      providerFailures: {
        finnhub: {
          source: "finnhub",
          upstreamFamily: "finnhub",
          fetchedAt: "2026-07-26T00:00:00.000Z",
          status: "failed",
          errorKind: "TimeoutError"
        }
      }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.fieldObservations?.peRatio?.source).toBe("yahoo-finance");
    expect(enriched.providerFailures?.finnhub?.errorKind).toBe("TimeoutError");
  });
});

describe("mergeQuoteData", () => {
  it("derives scan source attribution from the quote providers instead of hardcoding Robinhood", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL" })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL" }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    expect(merged.source).toBe("nasdaq-delayed-screener+alpaca-quotes");
    expect(merged.topCandidates[0]).toMatchObject({ price: 101, provider: "alpaca" });
  });

  it("does not duplicate quote provider sources when quote data is merged again", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener+alpaca-quotes",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL", provider: "alpaca" })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL", provider: "alpaca" }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    expect(merged.source).toBe("nasdaq-delayed-screener+alpaca-quotes");
  });

  it("refreshes synthetic bid/ask provenance when a real broker spread is merged in", () => {
    const synthetic = () =>
      quote({
        symbol: "AAPL",
        bid: 99.9,
        ask: 100.1,
        sources: { price: "yahoo-finance", bid: "yahoo-finance-synthetic", ask: "yahoo-finance-synthetic" }
      });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [synthetic()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: synthetic() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    // A real broker spread replaces the synthetic values AND their provenance — on both the ranked
    // candidate and the quotesBySymbol entry the marketable-limit calc reads — so a real ask is no
    // longer mistaken for synthetic and does not fall back to refPrice.
    expect(merged.topCandidates[0]!.ask).toBe(101.1);
    expect(merged.topCandidates[0]!.sources?.ask).toBe("alpaca");
    expect(merged.topCandidates[0]!.sources?.bid).toBe("alpaca");
    expect(merged.quotesBySymbol.AAPL!.sources?.ask).toBe("alpaca");
    expect(merged.quotesBySymbol.AAPL!.sources?.bid).toBe("alpaca");
  });

  it("keeps synthetic provenance when a Test-mode synthetic Yahoo batch spread is merged", () => {
    const withRealScreenerSource = () => quote({ symbol: "AAPL", sources: { price: "yahoo-finance" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [withRealScreenerSource()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: withRealScreenerSource() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // TestBrokerGateway returns a Yahoo BATCH quote whose bid/ask were synthesized from price.
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 100, bid: 99.9, ask: 100.1, provider: "yahoo-finance", syntheticSpread: true }
    });

    // The synthetic spread must NOT be relabeled as a real quoted spread — otherwise hasRealAsk /
    // marketable-limit pricing would treat a price-derived ask as real in the default Test mode.
    expect(merged.topCandidates[0]!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.topCandidates[0]!.sources?.bid).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.bid).toBe("yahoo-finance-synthetic");
  });

  it("preserves the REAL side of a one-sided quote (real bid, synthetic ask)", () => {
    const withRealScreenerSource = () => quote({ symbol: "AAPL", sources: { price: "yahoo-finance" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [withRealScreenerSource()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: withRealScreenerSource() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // Yahoo reported a real bid but no ask, so only the ask was derived from price.
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 100, bid: 99.9, ask: 100.1, provider: "yahoo-finance", syntheticAsk: true }
    });

    // The real bid keeps the actual provider; only the synthetic ask is tagged synthetic.
    expect(merged.topCandidates[0]!.sources?.bid).toBe("yahoo-finance");
    expect(merged.topCandidates[0]!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.bid).toBe("yahoo-finance");
    expect(merged.quotesBySymbol.AAPL!.sources?.ask).toBe("yahoo-finance-synthetic");
  });

  it("attributes a merged broker price to the broker provider (both tiers)", () => {
    const screenerPriced = () => quote({ symbol: "AAPL", sources: { price: "yahoo-finance" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [screenerPriced()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: screenerPriced() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // A live broker quote replaces `price`; sources.price must follow the value to the broker so the
    // drilldown/table price tooltip attributes the shown number correctly (it previously kept the
    // stale screener source).
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    expect(merged.topCandidates[0]!.price).toBe(101);
    expect(merged.topCandidates[0]!.sources?.price).toBe("alpaca");
    expect(merged.quotesBySymbol.AAPL!.sources?.price).toBe("alpaca");
  });

  it("attributes the real price provider even when the merged SPREAD is synthetic", () => {
    const screenerPriced = () => quote({ symbol: "AAPL", sources: { price: "nasdaq-delayed-screener" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [screenerPriced()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: screenerPriced() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // Yahoo batch quote: a REAL last price with a price-DERIVED (synthetic) spread. The synthetic
    // flags describe the derived bid/ask only — the price itself is real, so it takes the actual
    // provider while bid/ask stay tagged synthetic.
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 100, bid: 99.9, ask: 100.1, provider: "yahoo-finance", syntheticSpread: true }
    });

    expect(merged.topCandidates[0]!.sources?.price).toBe("yahoo-finance");
    expect(merged.topCandidates[0]!.sources?.bid).toBe("yahoo-finance-synthetic");
    expect(merged.topCandidates[0]!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.price).toBe("yahoo-finance");
  });

  it("recalculates intradayChangePct and netChange when fresh quote and prevClose are merged", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL", price: 100, intradayChangePct: 0, netChange: 0 })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL", price: 100, intradayChangePct: 0, netChange: 0 }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: {
        price: 105,
        prevClose: 100,
        open: 101,
        high: 106,
        low: 100.5,
        vwap: 103.5,
        companyName: "Apple Inc.",
        provider: "alpaca"
      }
    });

    const cand = merged.topCandidates[0];
    expect(cand.price).toBe(105);
    expect(cand.prevClose).toBe(100);
    expect(cand.intradayChangePct).toBe(5.0);
    expect(cand.netChange).toBe(5.0);
    expect(cand.open).toBe(101);
    expect(cand.high).toBe(106);
    expect(cand.low).toBe(100.5);
    expect(cand.vwap).toBe(103.5);
    expect(cand.companyName).toBe("Apple Inc.");

    const summary = merged.quotesBySymbol.AAPL;
    expect(summary.intradayChangePct).toBe(5.0);
    expect(summary.netChange).toBe(5.0);
    expect(summary.prevClose).toBe(100);
    expect(summary.open).toBe(101);
    expect(summary.high).toBe(106);
    expect(summary.low).toBe(100.5);
    expect(summary.vwap).toBe(103.5);
    expect(summary.companyName).toBe("Apple Inc.");
  });

  it("populates newly discovered symbols from quoteData with full quote metrics", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL" })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL" }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      MSFT: {
        symbol: "MSFT",
        price: 300,
        prevClose: 295,
        open: 296,
        high: 302,
        low: 294,
        vwap: 298.5,
        companyName: "Microsoft Corp",
        provider: "finnhub"
      }
    });

    expect(merged.quotesBySymbol.MSFT).toBeDefined();
    const msft = merged.quotesBySymbol.MSFT;
    expect(msft.price).toBe(300);
    expect(msft.prevClose).toBe(295);
    expect(msft.open).toBe(296);
    expect(msft.high).toBe(302);
    expect(msft.low).toBe(294);
    expect(msft.vwap).toBe(298.5);
    expect(msft.companyName).toBe("Microsoft Corp");
    expect(msft.intradayChangePct).toBe(1.69);
    expect(msft.netChange).toBe(5);
  });

  it("carries bidSize/askSize and uses cascade fieldProvenance receipts for observations", () => {
    const base = quote({
      symbol: "AAPL",
      price: 100,
      bid: 99.9,
      ask: 100.1,
      sources: { price: "screener" }
    });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [base],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: base },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };
    const merged = mergeQuoteData(scan, {
      AAPL: {
        price: 105,
        bid: 104.9,
        ask: 105.1,
        bidSize: 200,
        askSize: 300,
        prevClose: 100,
        vwap: 103,
        provider: "finnhub",
        asOf: "2026-09-21T10:05:00.000Z",
        fetchedAt: "2026-09-21T10:05:05.000Z",
        fieldProvenance: {
          price: { provider: "finnhub", asOf: "2026-09-21T10:05:00.000Z", fetchedAt: "2026-09-21T10:05:05.000Z" },
          prevClose: { provider: "alpaca", asOf: "2026-09-21T10:00:00.000Z", fetchedAt: "2026-09-21T10:00:05.000Z" },
          vwap: { provider: "alpaca", asOf: "2026-09-21T10:00:00.000Z", fetchedAt: "2026-09-21T10:00:05.000Z" },
          bidSize: { provider: "alpaca", asOf: "2026-09-21T10:00:00.000Z", fetchedAt: "2026-09-21T10:00:05.000Z" },
          askSize: { provider: "alpaca", asOf: "2026-09-21T10:00:00.000Z", fetchedAt: "2026-09-21T10:00:05.000Z" }
        }
      }
    });
    const cand = merged.topCandidates[0]!;
    expect(cand.bidSize).toBe(200);
    expect(cand.askSize).toBe(300);
    expect(cand.fieldObservations?.prevClose?.source).toBe("alpaca");
    expect(cand.fieldObservations?.vwap?.source).toBe("alpaca");
    expect(cand.fieldObservations?.price?.source).toBe("finnhub");
    expect(cand.fieldObservations?.bidSize?.source).toBe("alpaca");
    const summary = merged.quotesBySymbol.AAPL!;
    expect(summary.bidSize).toBe(200);
    expect(summary.askSize).toBe(300);
    expect(summary.fieldObservations?.prevClose?.source).toBe("alpaca");
  });
});

describe("mergeGroupedBarData", () => {
  it("adds source-provided VWAP to scan rows and summaries", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 2,
      returnedQuotes: 2,
      topCandidates: [quote({ symbol: "AAPL" }), quote({ symbol: "MSFT" })],
      sectorBySymbol: {},
      quotesBySymbol: {
        AAPL: quote({ symbol: "AAPL" }),
        MSFT: quote({ symbol: "MSFT" })
      },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeGroupedBarData(scan, [
      { ticker: "AAPL", close: 100, vwap: 98.5 },
      { ticker: "MSFT", close: 100 }
    ]);

    expect(merged.source).toBe("nasdaq-delayed-screener+massive-vwap");
    expect(merged.topCandidates[0]).toMatchObject({ symbol: "AAPL", vwap: 98.5, sources: { vwap: "massive-vwap" } });
    expect(merged.topCandidates[1].vwap).toBeUndefined();
    expect(merged.quotesBySymbol.AAPL).toMatchObject({ vwap: 98.5, sources: { vwap: "massive-vwap" } });
  });
});

describe("Wave 2C Stage 1/2 factor scoring overhaul & nightly OHLC rotation (ST-4666)", () => {
  it("liquidity: scores dollar volume log10(price * volumeOrAvgVol20d) rather than raw share volume", () => {
    // Low-priced penny share count (1M shares @ $2 = $2M) vs higher-priced institutional liquidity (500k shares @ $200 = $100M)
    const pennyHighShareCount = scoreFactors(quote({ symbol: "PENNY", price: 2, volume: 1_000_000 }));
    const highDollarVolume = scoreFactors(quote({ symbol: "INST", price: 200, volume: 500_000 }));
    expect(highDollarVolume.liquidity).toBeGreaterThan(pennyHighShareCount.liquidity);

    // Trailing 20d average volume takes precedence over noisy single-day volume
    const withAvgVol20d = scoreFactors(quote({ symbol: "AVG20", price: 100, volume: 10_000, avgVolume20d: 1_000_000 } as Partial<MarketQuote> & { symbol: string }));
    const withoutAvgVol20d = scoreFactors(quote({ symbol: "NOAVG", price: 100, volume: 10_000 }));
    expect(withAvgVol20d.liquidity).toBeGreaterThan(withoutAvgVol20d.liquidity);
  });

  it("momentum: scores multi-horizon trend (20d/60d/126d minus 5d short-term reversal) ahead of a 1-day spike", () => {
    const sustainedUptrendPullback = scoreFactors(
      quote({
        symbol: "TREND",
        intradayChangePct: -0.5,
        return20d: 12,
        return60d: 28,
        return126d: 45,
        return5d: -3
      } as Partial<MarketQuote> & { symbol: string })
    );
    const overextendedOneWeekChase = scoreFactors(
      quote({
        symbol: "CHASE",
        intradayChangePct: 6,
        return20d: 4,
        return60d: -5,
        return126d: -12,
        return5d: 15
      } as Partial<MarketQuote> & { symbol: string })
    );
    expect(sustainedUptrendPullback.momentum).toBeGreaterThan(overextendedOneWeekChase.momentum);
  });

  it("value & quality: returns neutral 50 when valuation is missing (no mega-cap marketCap >= 5B bias) and scores real fundamentals", () => {
    const megaCapNoValuation = scoreFactors(quote({ symbol: "MEGA", marketCap: 500_000_000_000, volume: 50_000_000 }));
    const smallCapNoValuation = scoreFactors(quote({ symbol: "SMID", marketCap: 400_000_000, volume: 200_000 }));
    expect(megaCapNoValuation.value).toBe(50);
    expect(smallCapNoValuation.value).toBe(50);
    expect(megaCapNoValuation.quality).toBe(50);
    expect(smallCapNoValuation.quality).toBe(50);

    const richFundamentals = scoreFactors(
      quote({
        symbol: "FUND",
        price: 100,
        marketCap: 800_000_000,
        pbRatio: 1.4,
        eps: 8, // 8% earnYld
        targetMean: 130, // +30% upside
        returnOnEquity: 24,
        grossProfitMargin: 58,
        revenueGrowth: 22 // percentage points, like ROE and margin
      })
    );
    expect(richFundamentals.value).toBeGreaterThan(75);
    expect(richFundamentals.quality).toBeGreaterThan(75);
  });

  it("volatility: scores 20d/60d realized volatility and ATR% rather than pure 1-day intraday change", () => {
    const lowRealizedVolWithIntradayMove = scoreFactors(
      quote({
        symbol: "STEADY",
        intradayChangePct: 3.5,
        realizedVol20d: 16,
        realizedVol60d: 18,
        atrPct: 1.1
      } as Partial<MarketQuote> & { symbol: string })
    );
    const highRealizedVolFlatToday = scoreFactors(
      quote({
        symbol: "CHOPPY",
        intradayChangePct: 0.1,
        realizedVol20d: 65,
        realizedVol60d: 70,
        atrPct: 4.8
      } as Partial<MarketQuote> & { symbol: string })
    );
    expect(lowRealizedVolWithIntradayMove.volatility).toBeGreaterThan(highRealizedVolFlatToday.volatility);
  });

  it("sentiment: downweights undated headline keyword score from 0.6 to 0.2 while keeping dated/direct scores higher", () => {
    const undatedHeadlineQuote = scoreFactors(
      quote({
        symbol: "UNDATED",
        sentiment: 90,
        headlines: ["Company surges on record growth"]
      })
    );
    const datedHeadlineQuote = scoreFactors(
      quote({
        symbol: "DATED",
        sentiment: 90,
        headlines: ["Company surges on record growth"],
        fieldObservations: {
          sentiment: {
            value: 90,
            source: "finnhub",
            upstreamFamily: "finnhub",
            asOf: "2026-11-23T14:00:00.000Z",
            fetchedAt: "2026-11-23T14:05:00.000Z",
            status: "ok"
          }
        }
      })
    );
    // Undated: 50 + (90 - 50) * 0.2 = 58
    expect(undatedHeadlineQuote.sentiment).toBe(58);
    expect(datedHeadlineQuote.sentiment).toBeGreaterThan(undatedHeadlineQuote.sentiment);
  });

  it("diversification: penalizes existing sector concentration when portfolioSectors are provided", () => {
    const concentratedSector = scoreFactors(
      quote({ symbol: "TECH1", sector: "Technology", positionMarketValue: 0 }),
      undefined,
      { portfolioSectors: { Technology: 0.75, Healthcare: 0.25 } }
    );
    const underrepresentedSector = scoreFactors(
      quote({ symbol: "HLTH1", sector: "Healthcare", positionMarketValue: 0 }),
      undefined,
      { portfolioSectors: { Technology: 0.75, Healthcare: 0.25 } }
    );
    const freshSector = scoreFactors(
      quote({ symbol: "IND1", sector: "Industrials", positionMarketValue: 0 }),
      undefined,
      { portfolioSectors: { Technology: 0.75, Healthcare: 0.25 } }
    );
    expect(freshSector.diversification).toBeGreaterThan(underrepresentedSector.diversification);
    expect(underrepresentedSector.diversification).toBeGreaterThan(concentratedSector.diversification);
  });

  it("nightly OHLC rotation: rotates broader-universe symbols into the technical watchlist across consecutive scans", () => {
    const top = ["T1", "T2", "T3", "T4", "T5"];
    const broader = ["T1", "T2", "T3", "T4", "T5", "B1", "B2", "B3", "B4", "B5", "B6"];
    const pass1 = buildRotatingTechnicalWatchlist(top, broader, 6);
    const pass2 = buildRotatingTechnicalWatchlist(top, broader, 6);

    expect(pass1).toHaveLength(6);
    expect(pass2).toHaveLength(6);
    // Both passes retain top candidates AND rotate distinct broader-universe symbols
    const broaderInPass1 = pass1.filter((s) => s.startsWith("B"));
    const broaderInPass2 = pass2.filter((s) => s.startsWith("B"));
    expect(broaderInPass1.length).toBeGreaterThan(0);
    expect(broaderInPass2.length).toBeGreaterThan(0);
    expect(broaderInPass2).not.toEqual(broaderInPass1);
  });
});

function quote(input: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 0,
    ...input
  };
}

// ── ST-4650 batch A1 regressions ─────────────────────────────────────────────

describe("ST-4650 A1: quotesBySymbol fields, fcf alias, persisted sharesOutstanding", () => {
  it("quotesBySymbol copies vwap/bidSize/askSize/OHLC/netChange/delayedFallback onto the summary", () => {
    const summaries = quotesBySymbol([
      quote({
        symbol: "AAPL",
        vwap: 99.5,
        bidSize: 200,
        askSize: 300,
        prevClose: 98,
        open: 98.5,
        high: 101,
        low: 97.5,
        netChange: 2,
        delayedFallback: true,
        fcfYield: 4.25
      })
    ]);
    const s = summaries.AAPL!;
    expect(s.vwap).toBe(99.5);
    expect(s.bidSize).toBe(200);
    expect(s.askSize).toBe(300);
    expect(s.prevClose).toBe(98);
    expect(s.open).toBe(98.5);
    expect(s.high).toBe(101);
    expect(s.low).toBe(97.5);
    expect(s.netChange).toBe(2);
    expect(s.delayedFallback).toBe(true);
    // fcf alias mirrored into freeCashFlowYield on the summary too.
    expect(s.fcfYield).toBe(4.25);
    expect(s.freeCashFlowYield).toBe(4.25);
  });

  it("applyEnrichment mirrors fcfYield into freeCashFlowYield (and keeps the reverse)", () => {
    const fromFcf = applyEnrichment(quote({ symbol: "AAPL" }), { fcfYield: 5.5 });
    expect(fromFcf.fcfYield).toBe(5.5);
    expect(fromFcf.freeCashFlowYield).toBe(5.5);
    const fromFree = applyEnrichment(quote({ symbol: "AAPL" }), { freeCashFlowYield: 6.5 });
    expect(fromFree.freeCashFlowYield).toBe(6.5);
    expect(fromFree.fcfYield).toBe(6.5);
    // A quote already carrying only fcfYield also mirrors on the next apply.
    const carried = applyEnrichment(quote({ symbol: "AAPL", fcfYield: 3.25 }), {});
    expect(carried.freeCashFlowYield).toBe(3.25);
  });

  it("persistedSlowEnrichment round-trips sharesOutstanding with its source", () => {
    const slow = persistedSlowEnrichment(
      quote({
        symbol: "AAPL",
        sharesOutstanding: 15_000_000_000,
        sources: { sharesOutstanding: "sec-xbrl", price: "yahoo-finance" }
      })
    );
    expect(slow.sharesOutstanding).toBe(15_000_000_000);
    expect(slow.sources?.sharesOutstanding).toBe("sec-xbrl");
    // Price-family provenance still excluded from the slow set.
    expect(slow.sources?.price).toBeUndefined();
  });
});

// ── ST-4679 OD-1: bar-derived quote fields producer ──────────────────────────

/** Deterministic daily bars (oldest -> newest): close = start + i*step, constant volume, real dates. */
function makeBars(
  count: number,
  opts: { start?: number; step?: number; volume?: number; highLowSpread?: number } = {}
): OHLCBar[] {
  const start = opts.start ?? 100;
  const step = opts.step ?? 1;
  const volume = opts.volume ?? 1_000_000;
  const spread = opts.highLowSpread ?? 0.5;
  const bars: OHLCBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = start + i * step;
    bars.push({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: close + spread,
      low: close - spread,
      close,
      volume
    });
  }
  return bars;
}

describe("barDerivedQuoteFields (ST-4679 OD-1 producer)", () => {
  it("returns percent close-to-close returns over the literal windows", () => {
    // 21 linear closes 100 -> 120: the 20d window spans 100 -> 120 = +20%.
    const fields = barDerivedQuoteFields(makeBars(21, { start: 100, step: 1 }));
    expect(fields.return20d).toBeCloseTo(20, 6);
    expect(fields.return5d).toBeCloseTo((120 / 115 - 1) * 100, 6);
    // 60d/126d windows are insufficient (only 21 bars) -> omitted.
    expect(fields.return60d).toBeUndefined();
    expect(fields.return126d).toBeUndefined();
  });

  it("emits avgVolume20d as the integer mean of the last 20 volumes", () => {
    expect(barDerivedQuoteFields(makeBars(25, { volume: 2_000_000 })).avgVolume20d).toBe(2_000_000);
  });

  it("omits avgVolume20d when any of the last 20 volumes is a hole", () => {
    const missing = makeBars(25, { volume: 2_000_000 });
    delete missing[missing.length - 1].volume;
    expect(barDerivedQuoteFields(missing).avgVolume20d).toBeUndefined();
    const zero = makeBars(25, { volume: 2_000_000 });
    zero[zero.length - 5].volume = 0; // zero counts as a hole
    expect(barDerivedQuoteFields(zero).avgVolume20d).toBeUndefined();
  });

  it("omits avgVolume20d with fewer than 20 bars", () => {
    expect(barDerivedQuoteFields(makeBars(19)).avgVolume20d).toBeUndefined();
  });

  it("flat closes give zero returns and zero realized volatility", () => {
    const fields = barDerivedQuoteFields(makeBars(70, { step: 0 }));
    expect(fields.return20d).toBe(0);
    expect(fields.return60d).toBe(0);
    expect(fields.realizedVol20d).toBe(0);
    expect(fields.realizedVol60d).toBe(0);
  });

  it("annualizes realized volatility from daily log returns (sqrt(252) * 100, percent)", () => {
    // Alternating 100 / 101 closes: log returns +/- ln(1.01). Independent expectation:
    const bars = makeBars(61, { step: 0 });
    for (let i = 0; i < bars.length; i++) bars[i].close = i % 2 === 0 ? 100 : 101;
    const closes = bars.slice(-21).map((b) => b.close);
    const lr: number[] = [];
    for (let i = 1; i < closes.length; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
    const mean = lr.reduce((s, r) => s + r, 0) / lr.length;
    const variance = lr.reduce((s, r) => s + (r - mean) ** 2, 0) / lr.length;
    const expected = Math.sqrt(variance) * Math.sqrt(252) * 100;
    const fields = barDerivedQuoteFields(bars);
    expect(fields.realizedVol20d).toBeCloseTo(expected, 6);
    expect(fields.realizedVol20d!).toBeGreaterThan(0);
  });

  it("omits a return when a close in its window is a hole", () => {
    const bars = makeBars(21, { start: 100, step: 1 });
    bars[bars.length - 10].close = 0; // hole inside the 20d window, outside the 5d window
    const fields = barDerivedQuoteFields(bars);
    expect(fields.return20d).toBeUndefined();
    expect(fields.return5d).toBeCloseTo((120 / 115 - 1) * 100, 6);
  });

  it("atrPct is ATR14 / last close * 100, omitted when ATR is undefined", () => {
    const bars = makeBars(30, { start: 100, step: 1, highLowSpread: 2 });
    const expectedAtr = atr(bars, 14)!;
    const fields = barDerivedQuoteFields(bars);
    expect(fields.atrPct).toBeCloseTo((expectedAtr / bars[bars.length - 1].close) * 100, 6);
    // Fewer than 15 bars -> ATR undefined -> atrPct omitted.
    expect(barDerivedQuoteFields(makeBars(10)).atrPct).toBeUndefined();
  });

  it("empty / insufficient series emit no fields", () => {
    expect(barDerivedQuoteFields([])).toEqual({});
    const tiny = barDerivedQuoteFields(makeBars(3));
    expect(tiny.return5d).toBeUndefined();
    expect(tiny.avgVolume20d).toBeUndefined();
    expect(tiny.realizedVol20d).toBeUndefined();
    expect(tiny.atrPct).toBeUndefined();
  });
});

describe("bar-derived fields reach the scan scores (ST-4679 OD-1)", () => {
  const fieldsMap = (symbol: string, fields: BarDerivedQuoteFields): Map<string, BarDerivedQuoteFields> =>
    new Map([[symbol, fields]]);

  it("multi-horizon returns drive momentum away from the 1-day fallback", () => {
    const base = quote({ symbol: "TREND", price: 100, volume: 1_000_000, intradayChangePct: 0 });
    const fallback = scoreFactors(base);
    const withFields = attachBarDerivedFields(
      base,
      fieldsMap("TREND", { return20d: 12, return60d: 28, return126d: 45, return5d: -3 })
    ) as MarketQuote & BarDerivedQuoteFields;
    expect(withFields.return20d).toBe(12);
    const scored = scoreFactors(withFields);
    expect(scored.momentum).not.toBe(fallback.momentum);
    // A sustained uptrend with a small 1-week pullback scores above the flat fallback.
    expect(scored.momentum).toBeGreaterThan(fallback.momentum);
  });

  it("realized volatility + ATR% drive the volatility (stability) sub-score", () => {
    const base = quote({ symbol: "VOL", price: 100, volume: 1_000_000, intradayChangePct: 3 });
    const steady = scoreFactors(
      attachBarDerivedFields(base, fieldsMap("VOL", { realizedVol20d: 16, realizedVol60d: 18, atrPct: 1.1 }))
    );
    const wild = scoreFactors(
      attachBarDerivedFields(base, fieldsMap("VOL", { realizedVol20d: 65, realizedVol60d: 70, atrPct: 4.8 }))
    );
    expect(steady.volatility).toBeGreaterThan(wild.volatility);
  });

  it("avgVolume20d lifts liquidity over same-day volume", () => {
    const base = quote({ symbol: "LIQ", price: 100, volume: 10_000 });
    const without = scoreFactors(base);
    const withAvg = scoreFactors(attachBarDerivedFields(base, fieldsMap("LIQ", { avgVolume20d: 1_000_000 })));
    expect(withAvg.liquidity).toBeGreaterThan(without.liquidity);
  });

  it("absent bars leave the quote and its scores byte-identical (fallback)", () => {
    const base = quote({ symbol: "NOBARS", price: 100, volume: 10_000, intradayChangePct: 2 });
    const empty = new Map<string, BarDerivedQuoteFields>();
    const attached = attachBarDerivedFields(base, empty);
    expect(attached).toBe(base); // unchanged reference
    expect(scoreFactors(attached)).toEqual(scoreFactors(base));
    // A map that lacks THIS symbol also leaves it unchanged.
    expect(attachBarDerivedFields(base, fieldsMap("OTHER", { return20d: 12 }))).toBe(base);
  });
});

describe("scan assembly attaches bar-derived fields from the EOD cache (ST-4679 OD-1)", () => {
  const dbUrl = `file:${join(tmpdir(), `agentic-market-barfields-${randomUUID()}.db`)}`;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalLocalHistory = process.env.MASSIVE_LOCAL_HISTORY_ENABLED;

  beforeEach(() => {
    process.env.DATABASE_URL = dbUrl;
    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "on";
    resetDbForTesting();
    getDb().exec("DELETE FROM history_cache_eod");
  });
  afterEach(() => {
    resetDbForTesting();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    if (originalLocalHistory === undefined) delete process.env.MASSIVE_LOCAL_HISTORY_ENABLED;
    else process.env.MASSIVE_LOCAL_HISTORY_ENABLED = originalLocalHistory;
  });

  it("bulk-reads seeded bars, derives fields, and attaches them ahead of scoring", () => {
    // 130 rising bars with real volume -> every horizon (incl. 126d) derivable. Freshness is
    // evaluated against an injected `now` on the series' own last day (makeBars stamps 2026-01-01+).
    upsertHistoryCacheEod("TESTPROD", makeBars(130, { start: 100, step: 1, volume: 2_000_000 }));
    const freshNow = Date.UTC(2026, 0, 1 + 130);
    const map = barDerivedFieldsBySymbol(["TESTPROD", "NOBARS"], freshNow);
    const fields = map.get("TESTPROD");
    expect(fields).toBeDefined();
    expect(fields!.return126d).toBeCloseTo((229 / 103 - 1) * 100, 6);
    expect(fields!.avgVolume20d).toBe(2_000_000);
    expect(fields!.realizedVol20d).toBeGreaterThan(0);
    expect(fields!.atrPct).toBeGreaterThan(0);
    expect(map.has("NOBARS")).toBe(false);

    const base = quote({ symbol: "TESTPROD", price: 229, volume: 10_000, intradayChangePct: 0 });
    const attached = attachBarDerivedFields(base, map) as MarketQuote & BarDerivedQuoteFields;
    expect(attached.return126d).toBe(fields!.return126d);
    expect(attached.avgVolume20d).toBe(2_000_000);
    const scored = scoreFactors(attached);
    const fallback = scoreFactors(base);
    expect(scored.momentum).not.toBe(fallback.momentum);
    expect(scored.liquidity).toBeGreaterThan(fallback.liquidity);
    // Absent symbol stays byte-identical.
    const noBars = quote({ symbol: "NOBARS", price: 100, volume: 10_000 });
    expect(attachBarDerivedFields(noBars, map)).toBe(noBars);
  });

  it("skips stale cached series instead of letting old bars drive live scoring", () => {
    upsertHistoryCacheEod("TESTSTALE", makeBars(130, { volume: 2_000_000 }));
    // Series ends 2026-05-20; a now far past the latest completed session must yield NOTHING.
    const staleNow = Date.UTC(2026, 11, 15);
    expect(barDerivedFieldsBySymbol(["TESTSTALE"], staleNow).size).toBe(0);
    // The same series is derivable when the session clock still covers it.
    expect(barDerivedFieldsBySymbol(["TESTSTALE"], Date.UTC(2026, 0, 1 + 130)).has("TESTSTALE")).toBe(true);
  });

  it("windows the bulk read to the trailing bars per ticker and keeps the 126d horizon derivable", () => {
    upsertHistoryCacheEod("TESTWINDOW", makeBars(200, { volume: 1_000_000 }));
    const bars = fetchHistoryCacheEodBulk(["TESTWINDOW"]).get("TESTWINDOW");
    expect(bars?.length).toBe(140); // HISTORY_CACHE_EOD_WINDOW_BARS
    expect(bars![bars!.length - 1].close).toBe(299); // tail preserved
    expect(bars![0].close).toBe(160); // oldest kept = start + 60 (200-140)
    // 140 >= 127 closes needed for the longest window.
    expect(barDerivedFieldsBySymbol(["TESTWINDOW"], Date.UTC(2026, 0, 1 + 200)).get("TESTWINDOW")?.return126d).toBeDefined();
  });

  it("bulk accessor returns the stored series and honors the off switch", () => {
    upsertHistoryCacheEod("TESTBULK", makeBars(30, { volume: 500_000 }));
    expect(fetchHistoryCacheEodBulk(["TESTBULK"]).get("TESTBULK")?.length).toBe(30);
    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "off";
    expect(fetchHistoryCacheEodBulk(["TESTBULK"]).size).toBe(0);
  });
});

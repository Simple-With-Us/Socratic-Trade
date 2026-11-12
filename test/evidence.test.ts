import { describe, expect, it } from "vitest";
import { buildCandidateEvidence } from "../src/lib/evidence";
import type { MarketQuote } from "../src/lib/types";

function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: "nvda",
    price: 123.45,
    volume: 1_000_000,
    intradayChangePct: 2.5,
    positionMarketValue: 0,
    score: 71,
    sector: "Technology",
    provider: "yahoo-finance",
    asOf: "2026-06-17T14:00:00.000Z",
    senateTrades: 3,
    insiderSentiment: 80,
    shortPercentOfFloat: 22,
    beta: 1.4,
    sectorRelStrength: 1.5,
    evidenceBulletins: ["b1", "b2", "b3", "b4"],
    sources: { senateTrades: "congress", insiderSentiment: "sec-edgar" },
    factorBreakdown: {
      liquidity: 60,
      momentum: 70,
      value: 40,
      quality: 55,
      volatility: 50,
      sentiment: 65,
      positioning: 80,
      diversification: 50,
      weightedTotal: 71
    },
    ...overrides
  };
}

describe("buildCandidateEvidence", () => {
  it("captures the full digest for a chosen candidate (normalized symbol, ref price, factors, capped bulletins)", () => {
    const ev = buildCandidateEvidence(quote(), {
      symbol: "nvda",
      chosen: true,
      regime: "Tech-Bull",
      side: "buy",
      status: "paper",
      thesisTag: "Momentum-Breakout"
    });

    expect(ev.symbol).toBe("NVDA"); // normalized
    expect(ev.chosen).toBe(true);
    expect(ev.side).toBe("buy");
    expect(ev.status).toBe("paper");
    expect(ev.thesisTag).toBe("Momentum-Breakout");
    expect(ev.regime).toBe("Tech-Bull");
    expect(ev.refPrice).toBe(123.45); // decision-time anchor for counterfactual returns
    expect(ev.score).toBe(71);
    expect(ev.sector).toBe("Technology");
    expect(ev.congressNet).toBe(3);
    expect(ev.insiderSentiment).toBe(80);
    expect(ev.shortPercentOfFloat).toBe(22);
    expect(ev.beta).toBe(1.4);
    expect(ev.sectorRelStrength).toBe(1.5);
    expect(ev.asOf).toBe("2026-06-17T14:00:00.000Z");
    expect(ev.provider).toBe("yahoo-finance");
    expect(ev.sources?.senateTrades).toBe("congress");
    expect(ev.factorBreakdown?.positioning).toBe(80);
    expect(ev.factorBreakdown?.weightedTotal).toBe(71);
    expect(ev.bulletins).toEqual(["b1", "b2", "b3"]); // capped at 3
  });

  it("stamps decision-time quote tape (bid/ask, sizes, fetchedAt, delayed/synthetic flags)", () => {
    const ev = buildCandidateEvidence(
      quote({
        bid: 123.4,
        ask: 123.5,
        bidSize: 10,
        askSize: 12,
        fetchedAt: "2026-06-17T14:00:01.000Z",
        delayedFallback: true,
        syntheticBid: true,
        syntheticAsk: false,
        venuePriceAuthoritative: false
      }),
      { symbol: "nvda", chosen: true, regime: "Tech-Bull" }
    );
    expect(ev.bid).toBe(123.4);
    expect(ev.ask).toBe(123.5);
    expect(ev.bidSize).toBe(10);
    expect(ev.askSize).toBe(12);
    expect(ev.volume).toBe(1_000_000);
    expect(ev.fetchedAt).toBe("2026-06-17T14:00:01.000Z");
    expect(ev.delayedFallback).toBe(true);
    expect(ev.syntheticBid).toBe(true);
    expect(ev.syntheticAsk).toBe(false);
    expect(ev.venuePriceAuthoritative).toBe(false);
  });

  it("captures backend-derived ratios (PEG, ROE, earnings yield, payout, $ volume) when inputs exist", () => {
    const ev = buildCandidateEvidence(
      quote({ price: 100, eps: 5, peRatio: 20, pbRatio: 2, dividendYield: 2, epsGrowth: 0.2, volume: 2_000_000 }),
      { symbol: "nvda", chosen: true, regime: "Tech-Bull", side: "buy", status: "paper", thesisTag: "Value-Quality" }
    );
    expect(ev.derived?.peg).toBe(1); // 20 / (0.2*100)
    expect(ev.derived?.earnYld).toBe(5); // 5/100*100
    expect(ev.derived?.roe).toBe(10); // 5*2/100*100
    expect(ev.derived?.payout).toBe(40); // 2*100/5
    expect(ev.derived?.dollarVolM).toBe(200); // 100*2e6/1e6
  });

  it("omits the derived block entirely when no quote is available", () => {
    const ev = buildCandidateEvidence(undefined, { symbol: "tsla", chosen: false, regime: "Neutral" });
    expect(ev.derived).toBeUndefined();
  });

  it("omits chosen-only fields for a skipped candidate", () => {
    const ev = buildCandidateEvidence(quote(), { symbol: "AMD", chosen: false, regime: "High-Vol" });
    expect(ev.chosen).toBe(false);
    expect(ev.side).toBeUndefined();
    expect(ev.status).toBeUndefined();
    expect(ev.thesisTag).toBeUndefined();
    expect(ev.regime).toBe("High-Vol");
    // Evidence fields still present so skipped names are fully analyzable later.
    expect(ev.score).toBe(71);
    expect(ev.factorBreakdown?.momentum).toBe(70);
  });

  it("degrades gracefully when no quote is available (symbol/chosen/regime only)", () => {
    const ev = buildCandidateEvidence(undefined, { symbol: "tsla", chosen: false, regime: "Neutral" });
    expect(ev.symbol).toBe("TSLA");
    expect(ev.chosen).toBe(false);
    expect(ev.regime).toBe("Neutral");
    expect(ev.refPrice).toBeUndefined();
    expect(ev.factorBreakdown).toBeUndefined();
    expect(ev.bulletins).toBeUndefined();
    // undefined-valued fields drop out of the persisted JSON, keeping the row compact.
    expect(JSON.parse(JSON.stringify(ev))).toEqual({ symbol: "TSLA", chosen: false, regime: "Neutral" });
  });
});

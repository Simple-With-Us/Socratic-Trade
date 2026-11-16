import { describe, expect, it } from "vitest";
import {
  buildDerivedTiles,
  buildSignalChips,
  buildSignalSummary,
  deriveForView,
  formatDollarsM,
  hasEnrichedData,
  normalizedDebtToEquity,
  peDisplay,
  positionEconomics,
  preferFreshQuote,
  ratingDistribution,
  targetUpsidePct,
  toQuoteView,
  toQuoteViewFromEnrichment,
  withProvenance,
  factorRows,
  type QuoteView
} from "../app/console/ui/drilldown-data";
import { resolveDrilldownCompanyName } from "../app/console/ui/symbol-drilldown";
import { deriveMetrics } from "../src/lib/derived-metrics";
import type { EquityPosition, MarketQuote, MarketQuoteSummary } from "../src/lib/types";

const fullQuote: MarketQuote = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  price: 200,
  volume: 50_000_000,
  marketCap: 3_000_000_000_000,
  intradayChangePct: 1.2,
  sector: "Technology",
  industry: "Consumer Electronics",
  positionMarketValue: 0,
  score: 72.4,
  factorBreakdown: {
    liquidity: 90,
    momentum: 70,
    value: 40,
    quality: 68,
    volatility: 60,
    sentiment: 62,
    positioning: 55,
    diversification: 80,
    weightedTotal: 72.4
  },
  peRatio: 30,
  eps: 6.6,
  pbRatio: 45,
  epsGrowth: 0.1,
  bid: 199.9,
  ask: 200.1,
  fiftyTwoWeekHigh: 240,
  fiftyTwoWeekLow: 160,
  sentiment: 62,
  insiderSentiment: 35,
  senateTrades: 2,
  daysToEarnings: 4,
  sectorRelStrength: 0.8,
  targetLow: 180,
  targetMean: 235,
  targetHigh: 280,
  analystRating: "Buy",
  analystScore: 78,
  analystBySource: {
    finnhub: { score: 78, label: "Buy", counts: { strongBuy: 12, buy: 20, hold: 8, sell: 1, strongSell: 0 } }
  },
  sources: { price: "yahoo-finance", peRatio: "yahoo-finance", sentiment: "finnhub", debtToEquity: "yahoo-finance" },
  asOf: new Date().toISOString()
};

const summaryQuote: MarketQuoteSummary = {
  symbol: "MSFT",
  companyName: "Microsoft",
  price: 450,
  score: 61,
  peRatio: 35,
  eps: 12.8,
  fiftyTwoWeekHigh: 480,
  fiftyTwoWeekLow: 360
};

describe("console drilldown: toQuoteView", () => {
  it("prefers the fully-enriched candidate quote and marks it full", () => {
    const view = toQuoteView(fullQuote, summaryQuote);
    expect(view?.full).toBe(true);
    expect(view?.symbol).toBe("AAPL");
    expect(view?.volume).toBe(50_000_000);
    expect(view?.factorBreakdown?.momentum).toBe(70);
    expect(view?.sectorRelStrength).toBe(0.8);
  });

  it("falls back to the summary tier without fabricating full-only fields", () => {
    const view = toQuoteView(undefined, summaryQuote);
    expect(view?.full).toBe(false);
    expect(view?.volume).toBeUndefined();
    expect(view?.factorBreakdown).toBeUndefined();
    expect(view?.intradayChangePct).toBeUndefined();
    expect(view?.peRatio).toBe(35);
  });

  it("surfaces factor fields from a summary-only quote (no full-tier candidate)", () => {
    const enrichedSummary: MarketQuoteSummary = {
      ...summaryQuote,
      factorBreakdown: fullQuote.factorBreakdown,
      headlines: ["MSFT ships new Copilot"],
      intradayChangePct: -0.4,
      volume: 22_000_000,
      sectorRelStrength: 0.3
    };
    const view = toQuoteView(undefined, enrichedSummary);
    expect(view?.full).toBe(false);
    expect(view?.factorBreakdown?.momentum).toBe(70);
    expect(view?.headlines).toEqual(["MSFT ships new Copilot"]);
    expect(view?.intradayChangePct).toBe(-0.4);
    expect(view?.volume).toBe(22_000_000);
    expect(view?.sectorRelStrength).toBe(0.3);
    expect(view?.marketCap).toBeUndefined(); // still full-tier-only
  });

  it("returns null when the scan didn't know the symbol", () => {
    expect(toQuoteView(undefined, undefined)).toBeNull();
  });

  it("drops non-positive prices instead of rendering them", () => {
    const view = toQuoteView(undefined, { ...summaryQuote, price: 0 });
    expect(view?.price).toBeUndefined();
  });
});

describe("console drilldown: preferFreshQuote (caller-supplied quote override)", () => {
  const at = (iso: string): MarketQuote => ({ ...fullQuote, asOf: iso });

  it("uses whichever side exists when the other is absent", () => {
    expect(preferFreshQuote(undefined, fullQuote)).toBe(fullQuote);
    const override = at("2026-07-02T10:00:00Z");
    expect(preferFreshQuote(override, undefined)).toBe(override);
    expect(preferFreshQuote(undefined, undefined)).toBeUndefined();
  });

  it("prefers the caller's on-screen quote so the drilldown can't disagree with the row", () => {
    const override = at("2026-07-02T10:00:00Z");
    const older = at("2026-07-02T09:00:00Z");
    expect(preferFreshQuote(override, older)).toBe(override);
  });

  it("still yields to a verifiably NEWER run-captured quote", () => {
    const override = at("2026-07-02T09:00:00Z");
    const newer = at("2026-07-02T10:00:00Z");
    expect(preferFreshQuote(override, newer)).toBe(newer);
  });

  it("keeps the override when timestamps are missing or unparseable", () => {
    const override = { ...fullQuote, asOf: undefined };
    const runQuote = at("2026-07-02T10:00:00Z");
    expect(preferFreshQuote(override, runQuote)).toBe(override);
    expect(preferFreshQuote(at("not-a-date"), runQuote)).toEqual(at("not-a-date"));
  });
});

describe("console drilldown: P/E honesty (repo convention)", () => {
  it("shows the number when a positive P/E exists and earnings are positive", () => {
    expect(peDisplay(30.04, 6.6)).toEqual({ text: "30.0", na: false });
    expect(peDisplay(30.04, undefined)).toEqual({ text: "30.0", na: false });
  });

  it("shows n/a for negative/zero earnings (real computed no-ratio state)", () => {
    expect(peDisplay(undefined, -2.4)).toEqual({ text: "n/a", na: true });
    expect(peDisplay(undefined, 0)).toEqual({ text: "n/a", na: true });
  });

  it("lets eps decide FIRST: eps <= 0 wins even when a provider still reports a ratio", () => {
    expect(peDisplay(25.3, -1.2)).toEqual({ text: "n/a", na: true });
    expect(peDisplay(25.3, 0)).toEqual({ text: "n/a", na: true });
  });

  it("never displays a non-positive ratio as a number", () => {
    expect(peDisplay(-12.5, undefined)).toBeNull();
    expect(peDisplay(0, undefined)).toBeNull();
  });

  it("returns null (em dash) when the data simply wasn't available", () => {
    expect(peDisplay(undefined, undefined)).toBeNull();
  });
});

describe("console drilldown: derived metrics reuse src/lib/derived-metrics verbatim", () => {
  it("matches deriveMetrics for the same inputs", () => {
    const view = toQuoteView(fullQuote, undefined)!;
    const { metrics } = deriveForView(view);
    const expected = deriveMetrics(fullQuote);
    expect(metrics).toEqual(expected);
  });

  it("falls back to the latest daily bar's volume for daily $ volume and says so", () => {
    const view = toQuoteView(undefined, summaryQuote)!;
    const noFallback = deriveForView(view);
    expect(noFallback.volumeFromHistory).toBe(false);
    expect(noFallback.metrics.dollarVolM).toBeUndefined();

    const withFallback = deriveForView(view, 2_000_000);
    expect(withFallback.volumeFromHistory).toBe(true);
    expect(withFallback.metrics.dollarVolM).toBe(Math.round((450 * 2_000_000) / 1e6));
    const tile = buildDerivedTiles(view, withFallback).find((t) => t.key === "dollarVolM")!;
    expect(tile.title).toContain("latest daily price bar");
  });

  it("renders all eleven legacy tiles with tooltips, missing values as null", () => {
    const view = toQuoteView(undefined, summaryQuote)!;
    const tiles = buildDerivedTiles(view, deriveForView(view));
    expect(tiles).toHaveLength(11);
    for (const tile of tiles) {
      expect(tile.title.length).toBeGreaterThan(20);
    }
    // No bid/ask on the summary fixture → spread honestly missing.
    expect(tiles.find((t) => t.key === "spreadBps")?.value).toBeNull();
    // Sector relative strength is a full-quote field.
    expect(tiles.find((t) => t.key === "sectorRelStrength")?.value).toBeNull();
  });
});

describe("console drilldown: signal summary (legacy threshold parity)", () => {
  it("reproduces the legacy pros/cons for a mixed quote", () => {
    const view = toQuoteView(fullQuote, undefined)!;
    const { metrics } = deriveForView(view);
    const { pros, cons } = buildSignalSummary(view, metrics);
    expect(pros).toContain("Strong overall composite score.");
    expect(pros).toContain("Positive news sentiment detected.");
    expect(pros).toContain("Delayed congressional disclosure context is net positive.");
    expect(pros).toContain("Strong relative momentum.");
    expect(pros).toContain("High quality fundamentals (FCF/Debt/Growth).");
    expect(cons).toContain("Bearish insider transaction activity.");
    // PEG = 30 / 10 = 3.0 > 2.5 → expensive for growth.
    expect(cons).toContain("Expensive relative to its growth (PEG > 2.5).");
    // ROE = eps*pb/price = 6.6*45/200 = 148.5% ≥ 20 → efficient capital use.
    expect(pros).toContain("High return on equity (efficient capital use).");
  });

  it("says nothing rather than inventing signals when data is missing", () => {
    const bare: QuoteView = { symbol: "X", full: false };
    const { pros, cons } = buildSignalSummary(bare, {});
    expect(pros).toEqual([]);
    expect(cons).toEqual([]);
  });
});

describe("console drilldown: signal chips", () => {
  it("builds earnings/news/insider/congress chips with honest tones", () => {
    const view = toQuoteView(fullQuote, undefined)!;
    const chips = buildSignalChips(view);
    const byKey = Object.fromEntries(chips.map((c) => [c.key, c]));
    expect(byKey.earnings.tone).toBe("warn"); // 4 trading days out
    expect(byKey.earnings.label).toBe("Earnings in 4 trading days");
    expect(byKey.sentiment.tone).toBe("pos"); // 62
    expect(byKey.insider.tone).toBe("neg"); // 35
    expect(byKey.congress.tone).toBe("pos"); // +2
    expect(byKey.congress.label).toBe("Congress +2");
  });

  it("omits chips whose signals are absent", () => {
    expect(buildSignalChips({ symbol: "X", full: false })).toEqual([]);
    // senateTrades of 0 = no distinct signal either way.
    expect(buildSignalChips({ symbol: "X", full: false, senateTrades: 0 })).toEqual([]);
  });
});

describe("console drilldown: position economics", () => {
  const long: EquityPosition = { symbol: "AAPL", quantity: 10, averageCost: 150, marketValue: 2000 };

  it("computes cost basis, P&L and return % for longs", () => {
    const econ = positionEconomics(long);
    expect(econ.costBasis).toBe(1500);
    expect(econ.pnl).toBe(500);
    expect(econ.returnPct).toBeCloseTo(33.333, 2);
    expect(econ.isShort).toBe(false);
  });

  it("flags shorts and withholds return % when cost basis isn't positive", () => {
    const short: EquityPosition = { symbol: "GME", quantity: -5, averageCost: 20, marketValue: -120 };
    const econ = positionEconomics(short);
    expect(econ.isShort).toBe(true);
    expect(econ.returnPct).toBeUndefined();
  });
});

describe("console drilldown: analyst helpers", () => {
  it("finds the first source with rating counts", () => {
    const view = toQuoteView(fullQuote, undefined)!;
    const dist = ratingDistribution(view);
    expect(dist?.source).toBe("finnhub");
    expect(dist?.total).toBe(41);
  });

  it("returns null when no source has counts", () => {
    expect(ratingDistribution({ symbol: "X", full: false })).toBeNull();
    expect(
      ratingDistribution({ symbol: "X", full: false, analystBySource: { yahoo: { score: 70, label: "Buy", mean: 1.8 } } })
    ).toBeNull();
  });

  it("computes upside to the mean target vs current price", () => {
    const view = toQuoteView(fullQuote, undefined)!;
    expect(targetUpsidePct(view)).toBeCloseTo(17.5, 4); // (235-200)/200
    expect(targetUpsidePct({ symbol: "X", full: false })).toBeUndefined();
  });
});

describe("console drilldown: provenance + misc formatting", () => {
  it("appends friendly per-field provenance when the scan recorded it", () => {
    const view = toQuoteView(fullQuote, undefined)!;
    expect(withProvenance("Price.", view, "price")).toContain("Source: Yahoo Finance.");
    expect(withProvenance("Sentiment.", view, "sentiment")).toContain("Source: Finnhub.");
    // No provenance recorded → no invented source line.
    expect(withProvenance("Volume.", view, "volume")).not.toContain("Source:");
  });

  it("only stamps 'Received' freshness on fields a provider actually supplied", () => {
    const view: QuoteView = {
      symbol: "X",
      full: false,
      asOf: new Date().toISOString(),
      peRatio: 12,
      sources: { peRatio: "yahoo-finance" }
    };
    // Sourced field → provenance + freshness.
    expect(withProvenance("P/E.", view, "peRatio")).toContain("Received");
    // Unsourced field (no provider returned it this scan) → no fabricated freshness:
    // "Received 2:00 PM" on a blank cell claimed we got data we never did.
    expect(withProvenance("FCF yield.", view, "fcfYield")).toBe("FCF yield.");
  });

  it("normalizes debt/equity like the legacy scan table (percent vs ratio, sec-xbrl exempt)", () => {
    expect(normalizedDebtToEquity({ symbol: "X", full: false, debtToEquity: 150 })).toBe(1.5);
    expect(normalizedDebtToEquity({ symbol: "X", full: false, debtToEquity: 1.5 })).toBe(1.5);
    expect(
      normalizedDebtToEquity({ symbol: "X", full: false, debtToEquity: 12, sources: { debtToEquity: "sec-xbrl" } })
    ).toBe(12);
    expect(normalizedDebtToEquity({ symbol: "X", full: false })).toBeUndefined();
  });

  it("formats daily $ volume buckets like the legacy drawer", () => {
    expect(formatDollarsM(2500)).toBe("$2.50B");
    expect(formatDollarsM(320)).toBe("$320M");
    expect(formatDollarsM(0.5)).toBe("$500K");
  });

});

describe("console drilldown: on-demand enrichment (symbol outside the last scan)", () => {
  it("builds a QuoteView from a live /api/quote fetch, marked not-full and score-less", () => {
    const view = toQuoteViewFromEnrichment("LRCX", {
      price: 78.2,
      companyName: "Lam Research",
      sector: "Technology",
      peRatio: 24.1,
      eps: 3.24,
      sentiment: 65,
      sources: { price: "webull-unofficial", peRatio: "yahoo-finance" }
    });
    expect(view.symbol).toBe("LRCX");
    expect(view.full).toBe(false);
    expect(view.price).toBe(78.2);
    expect(view.companyName).toBe("Lam Research");
    expect(view.peRatio).toBe(24.1);
    // Never fabricated: scan-only fields stay absent.
    expect(view.score).toBeUndefined();
    expect(view.factorBreakdown).toBeUndefined();
    expect(view.marketCap).toBeUndefined();
  });

  it("drops non-positive price-family values instead of rendering them", () => {
    const view = toQuoteViewFromEnrichment("X", { price: 0, bid: -1 });
    expect(view.price).toBeUndefined();
    expect(view.bid).toBeUndefined();
  });

  it("hasEnrichedData is true when any real field came back", () => {
    expect(hasEnrichedData(toQuoteViewFromEnrichment("LRCX", { peRatio: 24.1 }))).toBe(true);
    expect(hasEnrichedData(toQuoteViewFromEnrichment("LRCX", { headlines: ["Lam Research ships new tool"] }))).toBe(true);
  });

  it("hasEnrichedData is false when every provider came back empty (sources is always a defined-but-empty object)", () => {
    expect(hasEnrichedData(toQuoteViewFromEnrichment("ZZZZ", { sources: {} }))).toBe(false);
    expect(hasEnrichedData(toQuoteViewFromEnrichment("ZZZZ", {}))).toBe(false);
  });

  it("fills the drawer header name from on-demand identity while keeping scan identity authoritative", () => {
    const scan = toQuoteViewFromEnrichment("LRCX", { companyName: "Scan Name" });
    const onDemand = toQuoteViewFromEnrichment("LRCX", { companyName: "Lam Research Corporation" });
    expect(resolveDrilldownCompanyName(null, onDemand)).toBe("Lam Research Corporation");
    expect(resolveDrilldownCompanyName(scan, onDemand)).toBe("Scan Name");
    expect(resolveDrilldownCompanyName(null, toQuoteViewFromEnrichment("LRCX", { companyName: "  " }))).toBeUndefined();
  });
});

describe("console drilldown: factor rows derive from the breakdown's own keys", () => {
  it("shows every weighted factor — including diversification — but never weightedTotal", () => {
    const rows = factorRows(fullQuote.factorBreakdown!);
    expect(rows.map((r) => r.key)).toEqual([
      "value",
      "momentum",
      "quality",
      "positioning",
      "sentiment",
      "liquidity",
      "volatility",
      "diversification"
    ]);
    const div = rows.find((r) => r.key === "diversification")!;
    expect(div.value).toBe(80);
    expect(div.label).toBe("Diversification");
    expect(div.title).toContain("holds no position");
  });

  it("keeps unknown future factors visible with a fallback label and explainer", () => {
    const fb = { ...fullQuote.factorBreakdown!, catalystDensity: 63 } as never;
    const rows = factorRows(fb);
    const unknown = rows.find((r) => r.key === "catalystDensity")!;
    expect(unknown.value).toBe(63);
    expect(unknown.label).toBe("Catalyst density");
    expect(unknown.title).toContain("Factor sub-score");
    // Unknown keys sort after the known set.
    expect(rows[rows.length - 1].key).toBe("catalystDensity");
  });

  it("drops non-numeric entries instead of rendering fabricated bars", () => {
    const fb = { ...fullQuote.factorBreakdown!, momentum: Number.NaN } as never;
    const rows = factorRows(fb);
    expect(rows.some((r) => r.key === "momentum")).toBe(false);
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  __resetEnrichmentCoverageForTests,
  buildEnrichmentCoverageReport,
  collectFilledFields,
  COVERAGE_GAP_FIELDS,
  COVERAGE_RETIRED_LANE_FIELDS,
  COVERAGE_TRACKED_FIELDS,
  getLastEnrichmentCoverageReport,
  paidProviderHasUsefulWaveBGap,
  scarceProviderHasUsefulGap,
  symbolHasCoverageGap,
  WAVE_B_GAP_FIELDS,
  type EnrichmentCoverageRecord
} from "../src/lib/enrichment-coverage";
import {
  CascadingEnrichmentProvider,
  freeFirstEnrichmentEnabled,
  type MarketEnrichmentProvider,
  type SymbolEnrichment
} from "../src/lib/data-providers";

beforeEach(() => {
  __resetEnrichmentCoverageForTests();
  delete process.env.ENRICHMENT_FREE_FIRST_ENABLED;
});

afterEach(() => {
  delete process.env.ENRICHMENT_FREE_FIRST_ENABLED;
});

/** Scan-core complete free enrichment so the Wave B gate skips the symbol.
 *  Bid/ask/vwap/asOf are deliberately omitted — those must not force paid work. */
function coreComplete(overrides: SymbolEnrichment = {}): SymbolEnrichment {
  return {
    price: 200,
    intradayChangePct: 1,
    sentiment: 55,
    peRatio: 28,
    analystRating: "Buy",
    sector: "Technology",
    industry: "Consumer Electronics",
    volume: 1_000_000,
    dividendYield: 0.5,
    eps: 6,
    companyName: "Apple",
    pbRatio: 40,
    shortPercentOfFloat: 1,
    beta: 1.1,
    fiftyTwoWeekHigh: 220,
    fiftyTwoWeekLow: 140,
    daysToEarnings: 10,
    headlines: ["Apple news"],
    ...overrides
  };
}

describe("buildEnrichmentCoverageReport", () => {
  it("tracks marketCap in coverage field inventory", () => {
    expect(COVERAGE_TRACKED_FIELDS).toContain("marketCap");
    const report = buildEnrichmentCoverageReport(
      { AAPL: { marketCap: 3e12, sources: { marketCap: "nasdaq-delayed-screener" } } } as Record<
        string,
        EnrichmentCoverageRecord
      >,
      ["nasdaq-delayed-screener"]
    );
    const mcap = report.fields.find((f) => f.field === "marketCap");
    expect(mcap?.filledCount).toBe(1);
    expect(mcap?.mostFrequentSource).toBe("nasdaq-delayed-screener");
  });

  it("does not track retired Quiver lanes in coverage fields or missingFields", () => {
    for (const field of COVERAGE_RETIRED_LANE_FIELDS) {
      expect(COVERAGE_TRACKED_FIELDS).not.toContain(field);
    }
    const merged: Record<string, SymbolEnrichment> = {
      AAPL: { peRatio: 1, sources: { peRatio: "yahoo-finance" } }
    };
    const report = buildEnrichmentCoverageReport(merged, ["yahoo-finance"]);
    for (const field of COVERAGE_RETIRED_LANE_FIELDS) {
      expect(report.fields.some((f) => f.field === field)).toBe(false);
      expect(report.missingFields).not.toContain(field);
    }
  });

  it("reports fill rates, most-frequent source, missing fields, and failures", () => {
    const merged: Record<string, SymbolEnrichment> = {
      AAPL: {
        peRatio: 28,
        sector: "Technology",
        sources: { peRatio: "yahoo-finance", sector: "yahoo-finance" }
      },
      MSFT: {
        peRatio: 32,
        sources: { peRatio: "fmp-rapidapi" },
        providerFailures: {
          "yahoo-finance": {
            source: "yahoo-finance",
            upstreamFamily: "yahoo-finance",
            fetchedAt: "2026-07-26T00:00:00.000Z",
            status: "failed",
            errorKind: "AbortError"
          }
        }
      },
      NVDA: {
        sector: "Technology",
        sources: { sector: "yahoo-finance" }
      }
    };

    const report = buildEnrichmentCoverageReport(merged, ["yahoo-finance", "fmp-rapidapi"]);
    expect(getLastEnrichmentCoverageReport()).toBe(report);

    const pe = report.fields.find((f) => f.field === "peRatio");
    expect(pe?.filledCount).toBe(2);
    expect(pe?.winningSources).toEqual({ "yahoo-finance": 1, "fmp-rapidapi": 1 });
    // Tie → lexicographically smaller source wins "most frequent" label.
    expect(pe?.mostFrequentSource).toBe("fmp-rapidapi");

    const sector = report.fields.find((f) => f.field === "sector");
    expect(sector?.filledCount).toBe(2);
    expect(sector?.mostFrequentSource).toBe("yahoo-finance");

    expect(report.missingFields).toContain("eps");
    expect(report.providerFailures).toEqual([
      { provider: "yahoo-finance", failureCount: 1, errorKinds: ["AbortError"] }
    ]);
    expect(report.contributingSources).toEqual(["yahoo-finance", "fmp-rapidapi"]);
  });
});

describe("collectFilledFields / symbolHasCoverageGap", () => {
  it("treats empty arrays as not filled", () => {
    const results = [{ data: { AAPL: { headlines: [], sector: "Technology" } } }];
    const filled = collectFilledFields(results, "AAPL");
    expect(filled.has("sector")).toBe(true);
    expect(filled.has("headlines")).toBe(false);
    expect(symbolHasCoverageGap(filled)).toBe(true);
  });

  it("does not treat bid/ask/vwap/asOf as Wave B gaps once scan-core is filled", () => {
    const filled = new Set(WAVE_B_GAP_FIELDS);
    expect(symbolHasCoverageGap(filled, WAVE_B_GAP_FIELDS)).toBe(false);
    expect(symbolHasCoverageGap(filled, COVERAGE_GAP_FIELDS)).toBe(true);
  });

  it("skips a scarce SteadyAPI provider when price-family + profile are filled", () => {
    const filled = new Set(["price", "volume", "sector", "industry", "companyName"]);
    const supplies = [
      "price",
      "intradayChangePct",
      "volume",
      "companyName",
      "fiftyTwoWeekHigh",
      "fiftyTwoWeekLow",
      "sector",
      "industry"
    ];
    expect(scarceProviderHasUsefulGap("yahoo-finance15", supplies, filled)).toBe(false);
    expect(scarceProviderHasUsefulGap("yahoo-finance15", supplies, new Set(["price", "volume"]))).toBe(true);
  });

  it("does not treat bid/ask as a Wave B paid-provider gap", () => {
    const filled = new Set(["price", "peRatio", "volume", "sector"]);
    expect(
      paidProviderHasUsefulWaveBGap(["bid", "ask", "vwap", "peRatio", "price"], filled)
    ).toBe(false);
    expect(
      paidProviderHasUsefulWaveBGap(["bid", "ask", "daysToEarnings"], filled)
    ).toBe(true);
    expect(paidProviderHasUsefulWaveBGap(["bid", "ask", "vwap"], filled)).toBe(false);
  });

  it("treats analystBySource as filling analystRating so Yahoo does not ghost Wave B", () => {
    const filled = collectFilledFields(
      [
        {
          data: {
            AAPL: {
              peRatio: 28,
              analystBySource: { yahoo: { rating: "buy" } }
            } as unknown as EnrichmentCoverageRecord
          }
        }
      ],
      "AAPL"
    );
    expect(filled.has("analystRating")).toBe(true);
    expect(filled.has("analystBySource")).toBe(true);
  });

  it("does not treat headlines or sentiment as Wave B gaps", () => {
    expect(WAVE_B_GAP_FIELDS).not.toContain("headlines");
    expect(WAVE_B_GAP_FIELDS).not.toContain("sentiment");
    const filled = new Set(WAVE_B_GAP_FIELDS);
    expect(symbolHasCoverageGap(filled, WAVE_B_GAP_FIELDS)).toBe(false);
  });

  it("does not spend RapidAPI last-resort on a news-only hole", () => {
    const filled = new Set(["price", "volume", "sector", "industry", "peRatio", "eps", "companyName"]);
    expect(
      scarceProviderHasUsefulGap(
        "alpha-vantage-rapidapi",
        ["peRatio", "headlines", "sentiment", "eps", "sector"],
        filled
      )
    ).toBe(false);
    expect(
      scarceProviderHasUsefulGap(
        "real-time-finance-data",
        ["companyName", "price", "volume", "headlines", "sentiment"],
        filled
      )
    ).toBe(false);
  });
});

function freeStub(name: string, data: Record<string, SymbolEnrichment>): MarketEnrichmentProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name,
    configured: true,
    costTier: "free",
    calls,
    async enrich(symbols: string[]) {
      calls.push([...symbols]);
      return data;
    }
  };
}

function paidStub(
  name: string,
  data: Record<string, SymbolEnrichment> = {},
  suppliesFields?: readonly (keyof SymbolEnrichment)[]
): MarketEnrichmentProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name,
    configured: true,
    costTier: "paid",
    ...(suppliesFields ? { suppliesFields } : {}),
    calls,
    async enrich(symbols: string[]) {
      calls.push([...symbols]);
      return data;
    }
  };
}

function scarceStub(
  name: string,
  suppliesFields: readonly (keyof SymbolEnrichment)[],
  data: Record<string, SymbolEnrichment> = {}
): MarketEnrichmentProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name,
    configured: true,
    costTier: "paid",
    quotaScarce: true,
    suppliesFields,
    calls,
    async enrich(symbols: string[]) {
      calls.push([...symbols]);
      return data;
    }
  };
}

describe("freeFirstEnrichmentEnabled", () => {
  it("defaults ON", () => {
    delete process.env.ENRICHMENT_FREE_FIRST_ENABLED;
    expect(freeFirstEnrichmentEnabled()).toBe(true);
  });

  it("can be turned off", () => {
    process.env.ENRICHMENT_FREE_FIRST_ENABLED = "0";
    expect(freeFirstEnrichmentEnabled()).toBe(false);
  });
});

describe("free-first cascade planner", () => {
  it("runs free providers first, paid only for gap symbols, scarce only for remaining suppliesFields gaps", async () => {
    const yahoo = freeStub("yahoo-finance", {
      AAPL: coreComplete(),
      MSFT: { sector: "Technology", price: 400 }
    });
    const fmp = paidStub("fmp", {
      MSFT: { peRatio: 35, industry: "Software", returnOnEquity: 30 }
    });
    const scarce = scarceStub("mboum-finance", ["sector", "industry", "price"], {
      NVDA: { sector: "Technology", industry: "Semiconductors", price: 900 }
    });

    const cascade = new CascadingEnrichmentProvider([yahoo, fmp, scarce]);
    const result = await cascade.enrich(["AAPL", "MSFT", "NVDA"]);

    expect(yahoo.calls[0]).toEqual(["AAPL", "MSFT", "NVDA"]);
    // Paid only sees symbols with remaining CORE gaps (MSFT + NVDA); AAPL was core-complete.
    expect(fmp.calls).toHaveLength(1);
    expect(fmp.calls[0]).toEqual(["MSFT", "NVDA"]);
    expect(scarce.calls[0]).toContain("NVDA");
    expect(result.AAPL?.peRatio).toBe(28);
    expect(result.MSFT?.peRatio).toBe(35);
    expect(result.NVDA?.price).toBe(900);
    expect(cascade.coverageReport?.symbolCount).toBe(3);
    expect(cascade.coverageReport?.contributingSources).toContain("yahoo-finance");
  });

  it("retries a free provider that throws once before paid/scarce", async () => {
    let attempts = 0;
    const flaky: MarketEnrichmentProvider = {
      name: "yahoo-finance",
      configured: true,
      costTier: "free",
      async enrich(symbols: string[]) {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return { [symbols[0]]: { sector: "Technology", price: 10 } };
      }
    };
    const paid = paidStub("fmp");
    const cascade = new CascadingEnrichmentProvider([flaky, paid]);
    const result = await cascade.enrich(["AAPL"]);
    expect(attempts).toBe(2);
    expect(result.AAPL?.sector).toBe("Technology");
  });

  it("when free-first is OFF, paid still runs over the full batch (legacy)", async () => {
    process.env.ENRICHMENT_FREE_FIRST_ENABLED = "0";
    const yahoo = freeStub("yahoo-finance", { AAPL: { sector: "Technology", price: 200 } });
    const fmp = paidStub("fmp", { AAPL: { peRatio: 28 } });
    const cascade = new CascadingEnrichmentProvider([yahoo, fmp]);
    await cascade.enrich(["AAPL", "MSFT"]);
    expect(fmp.calls[0]).toEqual(["AAPL", "MSFT"]);
  });

  it("does not invoke paid Wave B when Yahoo filled scan-core without bid/ask/vwap", async () => {
    const yahoo = freeStub("yahoo-finance", { AAPL: coreComplete() });
    const paid = paidStub("finnhub");
    await new CascadingEnrichmentProvider([yahoo, paid]).enrich(["AAPL"]);
    expect(paid.calls).toEqual([]);
  });

  it("does not dispatch Finnhub for bid/ask when the symbol is only missing daysToEarnings", async () => {
    const yahoo = freeStub("yahoo-finance", {
      AAPL: coreComplete({ daysToEarnings: undefined })
    });
    const finnhub = paidStub("finnhub", {}, ["bid", "ask", "vwap", "peRatio", "price"]);
    const roic = paidStub("roic", { AAPL: { daysToEarnings: 12 } }, ["daysToEarnings", "epsGrowth"]);
    await new CascadingEnrichmentProvider([yahoo, finnhub, roic]).enrich(["AAPL"]);
    expect(finnhub.calls).toEqual([]);
    expect(roic.calls).toEqual([["AAPL"]]);
  });
});

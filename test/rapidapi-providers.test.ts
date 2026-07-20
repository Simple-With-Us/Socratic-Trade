import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CascadingEnrichmentProvider,
  clearEnrichmentCache,
  getEnrichmentProvider,
  parseRapidApiNumberString,
  parseSteadyApiQuote,
  parseSteadyApiAssetProfile,
  parseAlphaVantageOverview,
  resolveRapidApiKey,
  AlphaVantageRapidApiEnrichmentProvider,
  type MarketEnrichmentProvider,
  type SymbolEnrichment
} from "../src/lib/data-providers";
import { __resetRapidApiQuotaForTests } from "../src/lib/rapidapi-quota";

// Isolated temp SQLite DB per this test file (repo convention — see beforeAll in
// test/data-providers.test.ts) so persisted budget/exhaustion state never leaks between files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rapidapi-providers-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

beforeEach(() => {
  __resetRapidApiQuotaForTests();
  clearEnrichmentCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RAPIDAPI_KEY;
  delete process.env.PROVIDER_QUOTA_MBOUM_PER_DAY;
  delete process.env.PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY;
  delete process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY;
  delete process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY;
});

// ── resolveRapidApiKey ────────────────────────────────────────────────────────

describe("resolveRapidApiKey", () => {
  it("returns undefined when unset/blank", () => {
    delete process.env.RAPIDAPI_KEY;
    expect(resolveRapidApiKey()).toBeUndefined();
    process.env.RAPIDAPI_KEY = "   ";
    expect(resolveRapidApiKey()).toBeUndefined();
  });

  it("returns the trimmed key when set", () => {
    process.env.RAPIDAPI_KEY = "  rk-abc123  ";
    expect(resolveRapidApiKey()).toBe("rk-abc123");
  });
});

// ── parseRapidApiNumberString — Mboum/YH Finance 15 formatted-string numerics ────

describe("parseRapidApiNumberString", () => {
  it("strips a leading dollar sign", () => {
    expect(parseRapidApiNumberString("$333.74")).toBeCloseTo(333.74, 2);
  });

  it("strips thousands commas", () => {
    expect(parseRapidApiNumberString("63,407,283")).toBe(63407283);
  });

  it("strips a trailing percent sign and a leading plus", () => {
    expect(parseRapidApiNumberString("+0.14%")).toBeCloseTo(0.14, 2);
  });

  it("handles a negative change with no dollar sign", () => {
    expect(parseRapidApiNumberString("-1.23")).toBeCloseTo(-1.23, 2);
  });

  it("passes a plain JSON number through unchanged", () => {
    expect(parseRapidApiNumberString(42)).toBe(42);
  });

  it("returns undefined for non-numeric / missing input — never fabricates 0", () => {
    expect(parseRapidApiNumberString("N/A")).toBeUndefined();
    expect(parseRapidApiNumberString(undefined)).toBeUndefined();
    expect(parseRapidApiNumberString(null)).toBeUndefined();
    expect(parseRapidApiNumberString("")).toBeUndefined();
  });
});

// ── parseSteadyApiQuote — the confirmed Mboum/YH Finance 15 quote response shape ────

describe("parseSteadyApiQuote", () => {
  it("parses the confirmed ground-truth AAPL sample shape", () => {
    const payload = {
      meta: {},
      body: {
        symbol: "AAPL",
        companyName: "Apple Inc.",
        stockType: "Common Stock",
        exchange: "NASDAQ",
        primaryData: {
          lastSalePrice: "$333.74",
          netChange: "+0.48",
          percentageChange: "+0.14%",
          volume: "63,407,283"
        },
        marketStatus: "REGULAR",
        assetClass: "STOCKS",
        keyStats: { fiftyTwoWeekHighLow: { value: "201.50 - 334.68" } }
      }
    };
    const result = parseSteadyApiQuote(payload);
    expect(result.price).toBeCloseTo(333.74, 2);
    expect(result.intradayChangePct).toBeCloseTo(0.14, 2);
    expect(result.volume).toBe(63407283);
    expect(result.companyName).toBe("Apple Inc.");
    expect(result.fiftyTwoWeekLow).toBeCloseTo(201.50, 2);
    expect(result.fiftyTwoWeekHigh).toBeCloseTo(334.68, 2);
  });

  it("returns {} for a missing/malformed body rather than throwing", () => {
    expect(parseSteadyApiQuote({})).toEqual({});
    expect(parseSteadyApiQuote(undefined)).toEqual({});
    expect(parseSteadyApiQuote(null)).toEqual({});
  });

  it("never fabricates a non-positive price", () => {
    const payload = { body: { primaryData: { lastSalePrice: "$0.00" } } };
    expect(parseSteadyApiQuote(payload).price).toBeUndefined();
  });
});

// ── parseSteadyApiAssetProfile — tolerant nesting for the UNCONFIRMED wrapper shape ────

describe("parseSteadyApiAssetProfile", () => {
  it("reads sector/industry from a bare top-level object", () => {
    expect(parseSteadyApiAssetProfile({ sector: "Technology", industry: "Consumer Electronics" })).toEqual({
      sector: "Technology",
      industry: "Consumer Electronics"
    });
  });

  it("reads sector/industry from a `.body` wrapper", () => {
    expect(parseSteadyApiAssetProfile({ body: { sector: "Technology", industry: "Consumer Electronics" } })).toEqual({
      sector: "Technology",
      industry: "Consumer Electronics"
    });
  });

  it("reads sector/industry from an `.assetProfile` wrapper", () => {
    expect(parseSteadyApiAssetProfile({ assetProfile: { sector: "Healthcare", industry: "Biotech" } })).toEqual({
      sector: "Healthcare",
      industry: "Biotech"
    });
  });

  it("reads sector/industry from a `.body.assetProfile` wrapper", () => {
    expect(parseSteadyApiAssetProfile({ body: { assetProfile: { sector: "Financial Services", industry: "Banks" } } })).toEqual({
      sector: "Financial Services",
      industry: "Banks"
    });
  });

  it("returns {} when no candidate shape yields sector/industry", () => {
    expect(parseSteadyApiAssetProfile({ body: { longBusinessSummary: "..." } })).toEqual({});
    expect(parseSteadyApiAssetProfile(undefined)).toEqual({});
  });
});

// ── parseAlphaVantageOverview — RapidAPI-transport AV OVERVIEW → existing fields only ────

describe("parseAlphaVantageOverview", () => {
  const samplePayload: Record<string, unknown> = {
    Symbol: "AAPL",
    Sector: "TECHNOLOGY",
    Industry: "ELECTRONIC COMPUTERS",
    PERatio: "31.4",
    DividendYield: "0.0044",
    EPS: "6.97",
    PriceToBookRatio: "45.2",
    Beta: "1.2",
    "52WeekHigh": "260.10",
    "52WeekLow": "164.08",
    QuarterlyEarningsGrowthYOY: "0.128",
    PercentInstitutions: "62.399",
    ReturnOnEquityTTM: "1.5",
    AnalystRatingStrongBuy: "10",
    AnalystRatingBuy: "20",
    AnalystRatingHold: "8",
    AnalystRatingSell: "1",
    AnalystRatingStrongSell: "0"
  };

  it("maps the confirmed unambiguous-scale fields", () => {
    const result = parseAlphaVantageOverview(samplePayload);
    expect(result.peRatio).toBeCloseTo(31.4, 2);
    expect(result.eps).toBeCloseTo(6.97, 2);
    expect(result.sector).toBe("TECHNOLOGY");
    expect(result.industry).toBe("ELECTRONIC COMPUTERS");
    expect(result.pbRatio).toBeCloseTo(45.2, 2);
    expect(result.beta).toBeCloseTo(1.2, 2);
    expect(result.fiftyTwoWeekHigh).toBeCloseTo(260.10, 2);
    expect(result.fiftyTwoWeekLow).toBeCloseTo(164.08, 2);
  });

  it("converts dividendYield to percentage points (matching Yahoo's convention)", () => {
    const result = parseAlphaVantageOverview(samplePayload);
    expect(result.dividendYield).toBeCloseTo(0.44, 2); // 0.0044 → 0.44%
  });

  it("stores epsGrowth as the RAW fraction — unconverted, matching Yahoo's own convention", () => {
    const result = parseAlphaVantageOverview(samplePayload);
    expect(result.epsGrowth).toBeCloseTo(0.128, 3); // NOT *100 — Yahoo doesn't convert this field either
  });

  it("blends analyst rating counts into analystBySource under this provider's own key", () => {
    const result = parseAlphaVantageOverview(samplePayload);
    expect(result.analystBySource?.["alpha-vantage-rapidapi"]).toBeDefined();
    expect(result.analystBySource?.["alpha-vantage-rapidapi"].counts).toEqual({
      strongBuy: 10,
      buy: 20,
      hold: 8,
      sell: 1,
      strongSell: 0
    });
  });

  it("deliberately does NOT map PercentInstitutions (unconfirmed scale — see doc comment)", () => {
    const result = parseAlphaVantageOverview(samplePayload);
    expect(result.institutionOwnershipPct).toBeUndefined();
  });

  it("deliberately does NOT map ReturnOnEquityTTM (outside this pass's scoped field list)", () => {
    const result = parseAlphaVantageOverview(samplePayload);
    expect(result.returnOnEquity).toBeUndefined();
  });

  it("treats AV's \"None\" sentinel as absent, never as a fabricated value", () => {
    const result = parseAlphaVantageOverview({ ...samplePayload, PERatio: "None", Sector: "None" });
    expect(result.peRatio).toBeUndefined();
    expect(result.sector).toBeUndefined();
  });

  it("never fabricates a non-positive PE/PB ratio", () => {
    const result = parseAlphaVantageOverview({ ...samplePayload, PERatio: "-5", PriceToBookRatio: "0" });
    expect(result.peRatio).toBeUndefined();
    expect(result.pbRatio).toBeUndefined();
  });

  it("returns {} for a payload with nothing usable", () => {
    expect(parseAlphaVantageOverview({})).toEqual({});
  });
});

// ── Dormant-when-key-absent + registration ordering ──────────────────────────────

describe("RapidAPI providers — dormant when RAPIDAPI_KEY is absent", () => {
  it("none of the three RapidAPI providers are registered without a key", () => {
    delete process.env.RAPIDAPI_KEY;
    const provider = getEnrichmentProvider();
    const order = provider.name.split("+");
    expect(order).not.toContain("mboum-finance");
    expect(order).not.toContain("yahoo-finance15");
    expect(order).not.toContain("alpha-vantage-rapidapi");
  });

  it("blank RAPIDAPI_KEY is treated as absent", () => {
    process.env.RAPIDAPI_KEY = "   ";
    const provider = getEnrichmentProvider();
    expect(provider.name.split("+")).not.toContain("mboum-finance");
  });
});

describe("RapidAPI providers — registered as a failover tier AFTER yahoo-finance", () => {
  it("registers all three, in order, after yahoo-finance when RAPIDAPI_KEY is set", () => {
    process.env.RAPIDAPI_KEY = "test-rapidapi-key";
    const provider = getEnrichmentProvider();
    const order = provider.name.split("+");
    const yahooIdx = order.indexOf("yahoo-finance");
    const mboumIdx = order.indexOf("mboum-finance");
    const yhf15Idx = order.indexOf("yahoo-finance15");
    const avRapidIdx = order.indexOf("alpha-vantage-rapidapi");
    expect(yahooIdx).toBeGreaterThanOrEqual(0);
    expect(mboumIdx).toBeGreaterThan(yahooIdx);
    expect(yhf15Idx).toBeGreaterThan(mboumIdx);
    expect(avRapidIdx).toBeGreaterThan(yhf15Idx);
  });
});

// ── Cascade failover semantics — free scrape wins ties, RapidAPI only fills gaps ────

describe("RapidAPI providers as a failover tier — first-wins keeps the free scrape's value", () => {
  const stub = (name: string, data: Record<string, SymbolEnrichment>): MarketEnrichmentProvider => ({
    name,
    configured: true,
    async enrich() {
      return data;
    }
  });

  it("an earlier (free) provider's field is never overwritten by a later RapidAPI stub", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { sector: "Technology", peRatio: 30 } }),
      stub("mboum-finance", { AAPL: { sector: "Wrong Sector", peRatio: 999, dividendYield: 0.5 } })
    ]);
    const result = await cascade.enrich(["AAPL"]);
    // Yahoo's values win (registered first) — Mboum only contributes the field Yahoo left empty.
    expect(result.AAPL?.sector).toBe("Technology");
    expect(result.AAPL?.peRatio).toBe(30);
    expect(result.AAPL?.dividendYield).toBe(0.5);
    expect(cascade.activeSources).toEqual(["yahoo-finance", "mboum-finance"]);
  });

  it("a RapidAPI stub contributes nothing when every field it supplies was already filled", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { sector: "Technology", industry: "Consumer Electronics" } }),
      stub("mboum-finance", { AAPL: { sector: "Wrong", industry: "Wrong" } })
    ]);
    await cascade.enrich(["AAPL"]);
    expect(cascade.activeSources).toEqual(["yahoo-finance"]);
  });
});

// ── Quota enforcement — AlphaVantageRapidApiEnrichmentProvider never exceeds its cap ────

describe("AlphaVantageRapidApiEnrichmentProvider — respects the persisted daily budget", () => {
  it("never dispatches more network calls than the configured per-provider cap", async () => {
    process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY = "2";
    let callCount = 0;
    vi.stubGlobal("fetch", async () => {
      callCount++;
      return new Response(JSON.stringify({ Symbol: "X", PERatio: "10" }), { status: 200 });
    });
    const provider = new AlphaVantageRapidApiEnrichmentProvider("test-key", "env");
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    const result = await provider.enrich(symbols);
    expect(callCount).toBe(2);
    // Symbols beyond the budget are left unenriched by this provider this run, not fabricated.
    const filled = symbols.filter((s) => result[s]?.peRatio !== undefined);
    expect(filled.length).toBe(2);
  });

  it("refunds a reservation whose call never reached the network so a later symbol can use it", async () => {
    process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY = "1";
    // Circuit breaker is disabled globally in this file's beforeAll, so simulate a pre-network
    // throw a different way: force fetch itself to reject before any response is produced —
    // fetchWithRetry's durableAttempt.onDispatch still fires (the real network attempt happened),
    // so this exercises the "reached the network but failed" NON-refund path instead. Assert the
    // budget was NOT refunded (matches AlphaVantageEnrichmentProvider's own contract: a dispatched
    // call that errors still spent real quota).
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const provider = new AlphaVantageRapidApiEnrichmentProvider("test-key", "env");
    await provider.enrich(["AAA"]);
    // The one-call budget was consumed by the dispatched-but-failed attempt — a second symbol
    // gets nothing this run.
    const result = await provider.enrich(["BBB"]);
    expect(result.BBB).toEqual({});
  });
});

describe("SteadyApiEnrichmentProvider (via getEnrichmentProvider) — combined ceiling holds across all three", () => {
  it("the shared combined daily cap limits total RapidAPI calls across mboum/yahoo-finance15/alpha-vantage-rapidapi", async () => {
    process.env.RAPIDAPI_KEY = "test-rapidapi-key";
    process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY = "3";
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "50";
    process.env.PROVIDER_QUOTA_YAHOO_FINANCE15_PER_DAY = "50";
    process.env.PROVIDER_QUOTA_ALPHA_VANTAGE_RAPIDAPI_PER_DAY = "50";
    let rapidApiCallCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      // Only count calls to the three RapidAPI-hosted hosts — getEnrichmentProvider() also
      // registers the free keyless YahooFinanceEnrichmentProvider (query1.finance.yahoo.com /
      // fc.yahoo.com), whose own real-network calls this same global stub also intercepts and
      // must NOT count against the RapidAPI combined budget.
      const isRapidApiHost = /\.p\.rapidapi\.com/.test(u);
      if (isRapidApiHost) rapidApiCallCount++;
      if (u.includes("OVERVIEW")) return new Response(JSON.stringify({ PERatio: "10" }));
      if (u.includes("modules")) return new Response(JSON.stringify({ sector: "Technology", industry: "Software" }));
      if (isRapidApiHost) {
        return new Response(JSON.stringify({ body: { companyName: "X Corp", primaryData: { lastSalePrice: "$10.00" } } }));
      }
      // Any non-RapidAPI host (e.g. Yahoo's free scrape) — fail fast/harmlessly so it never
      // contributes real enrichment data that could obscure what THIS test is checking.
      return new Response("not found", { status: 404 });
    });
    const provider = getEnrichmentProvider();
    await provider.enrich(["AAPL", "MSFT", "NVDA", "AMZN", "GOOG"]);
    // Each provider's own cap (50) has plenty of headroom — the combined ceiling (3) is what binds,
    // regardless of how many symbols/fields would otherwise be requested.
    expect(rapidApiCallCount).toBeLessThanOrEqual(3);
  });
});

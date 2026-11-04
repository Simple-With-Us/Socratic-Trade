import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors the pattern in test/quiver-provider.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-simfin-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

describe("SimFin enrichment provider", () => {
  const originalKey = process.env.SIMFIN_API_KEY;
  const originalNegTtl = process.env.SIMFIN_NEGATIVE_CACHE_TTL_MS;
  const originalTtl = process.env.SIMFIN_CACHE_TTL_MS;

  beforeEach(async () => {
    delete process.env.SIMFIN_API_KEY;
    delete process.env.SIMFIN_NEGATIVE_CACHE_TTL_MS;
    delete process.env.SIMFIN_CACHE_TTL_MS;
    const { clearSimFinCache } = await import("../src/lib/simfin-provider");
    clearSimFinCache();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalKey) process.env.SIMFIN_API_KEY = originalKey;
    else delete process.env.SIMFIN_API_KEY;
    if (originalNegTtl) process.env.SIMFIN_NEGATIVE_CACHE_TTL_MS = originalNegTtl;
    else delete process.env.SIMFIN_NEGATIVE_CACHE_TTL_MS;
    if (originalTtl) process.env.SIMFIN_CACHE_TTL_MS = originalTtl;
    else delete process.env.SIMFIN_CACHE_TTL_MS;
    const { clearSimFinCache } = await import("../src/lib/simfin-provider");
    clearSimFinCache();
    vi.unstubAllGlobals();
  });

  // ── Key resolution ─────────────────────────────────────────────────────────

  it("resolveSimFinApiKey trims whitespace and treats blank as unset", async () => {
    const { resolveSimFinApiKey } = await import("../src/lib/simfin-provider");
    process.env.SIMFIN_API_KEY = "  abc123  ";
    expect(resolveSimFinApiKey()).toBe("abc123");
    process.env.SIMFIN_API_KEY = "   ";
    expect(resolveSimFinApiKey()).toBeUndefined();
    delete process.env.SIMFIN_API_KEY;
    expect(resolveSimFinApiKey()).toBeUndefined();
  });

  it("declares quotaScarce + suppliesFields so the cascade wave-gates it to uncovered symbols", async () => {
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    expect(provider.quotaScarce).toBe(true);
    expect(provider.suppliesFields).toEqual(
      expect.arrayContaining(["grossProfitMargin", "revenueGrowth", "returnOnEquity", "returnOnAssets", "debtToEquity"])
    );
  });

  // ── Row extraction (realistic "compact" columns/data table shape, live-verified 2026-08-02) ──

  it("extractSimFinRows flattens a flat array of {columns, data} tables (one per requested ticker)", async () => {
    const { extractSimFinRows } = await import("../src/lib/simfin-provider");
    const payload = [
      {
        columns: ["Ticker", "Company Name", "Sector", "Industry"],
        data: [["AAPL", "Apple Inc.", "Technology", "Consumer Electronics"]]
      }
    ];
    const rows = extractSimFinRows(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      Ticker: "AAPL",
      "Company Name": "Apple Inc.",
      Sector: "Technology",
      Industry: "Consumer Electronics"
    });
  });

  it("extractSimFinRows finds a columns/data table nested arbitrarily deep (defensive against an unverified envelope shape)", async () => {
    const { extractSimFinRows } = await import("../src/lib/simfin-provider");
    const payload = {
      results: [
        {
          ticker: "AAPL",
          statements: {
            pl: {
              columns: ["Fiscal Year", "Revenue", "Gross Profit", "Net Income"],
              data: [
                [2025, 400000, 180000, 90000],
                [2024, 380000, 170000, 85000]
              ]
            }
          }
        }
      ]
    };
    const rows = extractSimFinRows(payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ "Fiscal Year": 2025, Revenue: 400000, "Gross Profit": 180000, "Net Income": 90000 });
    expect(rows[1]["Fiscal Year"]).toBe(2024);
  });

  it("extractSimFinRows tolerates a row that is already a keyed object instead of a positional array", async () => {
    const { extractSimFinRows } = await import("../src/lib/simfin-provider");
    const payload = [{ columns: ["Ticker"], data: [{ Ticker: "MSFT" }] }];
    expect(extractSimFinRows(payload)).toEqual([{ Ticker: "MSFT" }]);
  });

  it("extractSimFinRows returns [] for malformed/empty input, never a fabricated row", async () => {
    const { extractSimFinRows } = await import("../src/lib/simfin-provider");
    expect(extractSimFinRows(null)).toEqual([]);
    expect(extractSimFinRows(undefined)).toEqual([]);
    expect(extractSimFinRows({})).toEqual([]);
    expect(extractSimFinRows([])).toEqual([]);
    expect(extractSimFinRows({ error: "Full authentication is required to access this resource" })).toEqual([]);
    expect(extractSimFinRows([{ columns: ["A"], data: [] }])).toEqual([]);
    expect(extractSimFinRows([{ columns: [1, 2], data: [[1, 2]] }])).toEqual([]); // non-string columns
  });

  // ── Company-info parsing ───────────────────────────────────────────────────

  it("parseGeneralInfo reads companyName/sector/industry from the first row", async () => {
    const { parseGeneralInfo } = await import("../src/lib/simfin-provider");
    const out = parseGeneralInfo([{ Ticker: "AAPL", "Company Name": "Apple Inc.", Sector: "Technology", Industry: "Consumer Electronics" }]);
    expect(out).toEqual({ companyName: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics" });
  });

  it("parseGeneralInfo returns {} when there are no rows (unknown ticker / empty response)", async () => {
    const { parseGeneralInfo } = await import("../src/lib/simfin-provider");
    expect(parseGeneralInfo([])).toEqual({});
  });

  // ── Ratio computation (realistic annual PL/BS rows) ────────────────────────

  it("computeSimFinRatios computes grossProfitMargin, revenueGrowth, returnOnEquity, returnOnAssets, and debtToEquity from two fiscal years", async () => {
    const { computeSimFinRatios } = await import("../src/lib/simfin-provider");
    const plRows = [
      { "Fiscal Year": 2025, Revenue: 400_000, "Gross Profit": 180_000, "Net Income": 90_000 },
      { "Fiscal Year": 2024, Revenue: 380_000, "Gross Profit": 170_000, "Net Income": 85_000 }
    ];
    const bsRows = [
      { "Fiscal Year": 2025, "Total Assets": 1_000_000, "Total Equity": 500_000, "Short Term Debt": 20_000, "Long Term Debt": 180_000 },
      { "Fiscal Year": 2024, "Total Assets": 900_000, "Total Equity": 450_000, "Short Term Debt": 15_000, "Long Term Debt": 175_000 }
    ];
    const out = computeSimFinRatios(plRows, bsRows);
    expect(out.grossProfitMargin).toBe(45); // 180000/400000 * 100
    expect(out.revenueGrowth).toBe(round((400_000 - 380_000) / 380_000 * 100));
    expect(out.returnOnEquity).toBe(round((90_000 / 500_000) * 100));
    expect(out.returnOnAssets).toBe(round((90_000 / 1_000_000) * 100));
    expect(out.debtToEquity).toBe(round((20_000 + 180_000) / 500_000));
  });

  it("computeSimFinRatios omits revenueGrowth when only a single fiscal year is available", async () => {
    const { computeSimFinRatios } = await import("../src/lib/simfin-provider");
    const plRows = [{ "Fiscal Year": 2025, Revenue: 400_000, "Gross Profit": 180_000, "Net Income": 90_000 }];
    const bsRows = [{ "Fiscal Year": 2025, "Total Assets": 1_000_000, "Total Equity": 500_000 }];
    const out = computeSimFinRatios(plRows, bsRows);
    expect(out.revenueGrowth).toBeUndefined();
    expect(out.grossProfitMargin).toBe(45);
    expect(out.returnOnEquity).toBe(18);
    expect(out.returnOnAssets).toBe(9);
    // Neither debt concept present on the BS row -> omitted, never assumed zero.
    expect(out.debtToEquity).toBeUndefined();
  });

  it("computeSimFinRatios omits returnOnEquity/returnOnAssets/debtToEquity when equity is zero or negative (never divides by a non-positive denominator)", async () => {
    const { computeSimFinRatios } = await import("../src/lib/simfin-provider");
    const plRows = [{ "Fiscal Year": 2025, Revenue: 400_000, "Gross Profit": 180_000, "Net Income": -50_000 }];
    const bsRows = [{ "Fiscal Year": 2025, "Total Assets": 1_000_000, "Total Equity": -20_000, "Long Term Debt": 100_000 }];
    const out = computeSimFinRatios(plRows, bsRows);
    expect(out.returnOnEquity).toBeUndefined();
    expect(out.debtToEquity).toBeUndefined();
    // returnOnAssets only needs positive Total Assets, which is unaffected by negative equity.
    expect(out.returnOnAssets).toBe(round((-50_000 / 1_000_000) * 100));
  });

  it("computeSimFinRatios treats a debt concept present only on one side (ST or LT) as the other contributing 0, not as missing", async () => {
    const { computeSimFinRatios } = await import("../src/lib/simfin-provider");
    const bsRows = [{ "Fiscal Year": 2025, "Total Equity": 500_000, "Long Term Debt": 100_000 }];
    const out = computeSimFinRatios([], bsRows);
    expect(out.debtToEquity).toBe(round(100_000 / 500_000));
  });

  it("computeSimFinRatios returns {} for empty input", async () => {
    const { computeSimFinRatios } = await import("../src/lib/simfin-provider");
    expect(computeSimFinRatios([], [])).toEqual({});
  });

  function round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  // ── Provider enrich() behavior: fetch wiring, caching, negative TTL, fail-open ──

  function stubEndpoints(bySymbol: Record<string, { general?: unknown; pl?: unknown; bs?: unknown; error?: string[] }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const symbolMatch = /ticker=([A-Z]+)/.exec(url);
        const symbol = symbolMatch?.[1] ?? "";
        const entry = bySymbol[symbol];
        if (!entry) return new Response(JSON.stringify([]), { status: 200 });

        const isGeneral = url.includes("companies/general/compact");
        const isPl = url.includes("statements=PL");
        const isBs = url.includes("statements=BS");

        if (isGeneral && entry.error?.includes("general")) throw new Error("network down");
        if (isPl && entry.error?.includes("pl")) throw new Error("network down");
        if (isBs && entry.error?.includes("bs")) throw new Error("network down");

        if (isGeneral) return new Response(JSON.stringify(entry.general ?? []), { status: 200 });
        if (isPl) return new Response(JSON.stringify(entry.pl ?? []), { status: 200 });
        if (isBs) return new Response(JSON.stringify(entry.bs ?? []), { status: 200 });
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
  }

  function generalPayload(ticker: string, companyName: string, sector: string, industry: string) {
    return [{ columns: ["Ticker", "Company Name", "Sector", "Industry"], data: [[ticker, companyName, sector, industry]] }];
  }

  function plPayload(rows: Array<[number, number, number, number]>) {
    return [{ columns: ["Fiscal Year", "Revenue", "Gross Profit", "Net Income"], data: rows }];
  }

  function bsPayload(rows: Array<[number, number, number, number, number]>) {
    return [{ columns: ["Fiscal Year", "Total Assets", "Total Equity", "Short Term Debt", "Long Term Debt"], data: rows }];
  }

  it("enrich() produces company info + ratio fields from a fully successful fetch", async () => {
    stubEndpoints({
      AAPL: {
        general: generalPayload("AAPL", "Apple Inc.", "Technology", "Consumer Electronics"),
        pl: plPayload([
          [2025, 400_000, 180_000, 90_000],
          [2024, 380_000, 170_000, 85_000]
        ]),
        bs: bsPayload([[2025, 1_000_000, 500_000, 20_000, 180_000]])
      }
    });
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    const out = await provider.enrich(["AAPL"]);
    expect(out.AAPL.companyName).toBe("Apple Inc.");
    expect(out.AAPL.sector).toBe("Technology");
    expect(out.AAPL.industry).toBe("Consumer Electronics");
    expect(out.AAPL.grossProfitMargin).toBe(45);
    expect(out.AAPL.revenueGrowth).toBeCloseTo(5.26, 1);
    expect(out.AAPL.returnOnEquity).toBe(18);
    expect(out.AAPL.returnOnAssets).toBe(9);
    expect(out.AAPL.debtToEquity).toBe(0.4);
    // Never populated by this provider (see file header: requires price data or a TTM figure
    // this provider deliberately does not attempt).
    expect(out.AAPL.eps).toBeUndefined();
    expect(out.AAPL.peRatio).toBeUndefined();
  });

  it("requests the expected SimFin endpoints with the documented auth header and query params", async () => {
    stubEndpoints({
      MSFT: {
        general: generalPayload("MSFT", "Microsoft Corp.", "Technology", "Software"),
        pl: plPayload([[2025, 200_000, 100_000, 50_000]]),
        bs: bsPayload([[2025, 500_000, 300_000, 0, 50_000]])
      }
    });
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key-123");
    await provider.enrich(["MSFT"]);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [url, init] of calls) {
      expect(url).toContain("https://backend.simfin.com/api/v3/");
      expect(url).toContain("ticker=MSFT");
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "api-key test-key-123" });
    }
    const urls = calls.map((call) => call[0] as string);
    expect(urls.some((u) => u.includes("companies/general/compact"))).toBe(true);
    expect(urls.some((u) => u.includes("companies/statements/compact") && u.includes("statements=PL") && u.includes("period=FY"))).toBe(true);
    expect(urls.some((u) => u.includes("companies/statements/compact") && u.includes("statements=BS") && u.includes("period=FY"))).toBe(true);
  });

  it("caches a fully successful result and does not refetch within the TTL", async () => {
    stubEndpoints({
      NFLX: {
        general: generalPayload("NFLX", "Netflix Inc.", "Communication Services", "Entertainment"),
        pl: plPayload([[2025, 40_000, 20_000, 6_000]]),
        bs: bsPayload([[2025, 60_000, 20_000, 0, 15_000]])
      }
    });
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    await provider.enrich(["NFLX"]);
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(3); // general + PL + BS
    await provider.enrich(["NFLX"]);
    const callsAfterSecond = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // served entirely from cache
  });

  it("fails open on a partial failure: surfaces company info even when both statement fetches fail", async () => {
    stubEndpoints({
      TSLA: {
        general: generalPayload("TSLA", "Tesla, Inc.", "Consumer Discretionary", "Automobiles"),
        error: ["pl", "bs"]
      }
    });
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    const out = await provider.enrich(["TSLA"]);
    expect(out.TSLA.companyName).toBe("Tesla, Inc.");
    expect(out.TSLA.grossProfitMargin).toBeUndefined();
    expect(out.TSLA.returnOnEquity).toBeUndefined();
  });

  it("fails open on a partial failure: surfaces ratio fields even when the general-info fetch fails", async () => {
    stubEndpoints({
      GME: {
        error: ["general"],
        pl: plPayload([[2025, 5_000, 2_000, 200]]),
        bs: bsPayload([[2025, 3_000, 1_500, 0, 300]])
      }
    });
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    const out = await provider.enrich(["GME"]);
    expect(out.GME.companyName).toBeUndefined();
    expect(out.GME.grossProfitMargin).toBe(40);
  });

  it("caches a partial-failure result under the shorter negative TTL and retries sooner than the positive floor", async () => {
    process.env.SIMFIN_NEGATIVE_CACHE_TTL_MS = "1"; // effectively immediate re-eligibility
    let generalCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("companies/general/compact")) {
          generalCalls++;
          throw new Error("network down");
        }
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    await provider.enrich(["AMD"]);
    expect(generalCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.enrich(["AMD"]);
    expect(generalCalls).toBe(2);
  });

  it("never throws out of enrich() even when every sub-fetch fails (fail-open)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("total outage");
      })
    );
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    const out = await provider.enrich(["ZZZZ"]);
    expect(out.ZZZZ).toEqual({});
  });

  it("enrich() on an empty symbol list returns {} without making any calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const provider = new SimFinEnrichmentProvider("test-key");
    const out = await provider.enrich([]);
    expect(out).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Cascade integration: a produced value actually lands in SymbolEnrichment via takeScalar ──

  it("a SimFin-produced value flows through CascadingEnrichmentProvider's takeScalar into the merged SymbolEnrichment with correct source attribution", async () => {
    stubEndpoints({
      AMZN: {
        general: generalPayload("AMZN", "Amazon.com, Inc.", "Consumer Discretionary", "Internet Retail"),
        pl: plPayload([
          [2025, 600_000, 250_000, 40_000],
          [2024, 550_000, 230_000, 35_000]
        ]),
        bs: bsPayload([[2025, 900_000, 250_000, 10_000, 90_000]])
      }
    });
    const { SimFinEnrichmentProvider } = await import("../src/lib/simfin-provider");
    const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = new SimFinEnrichmentProvider("test-key");
    const cascade = new CascadingEnrichmentProvider([provider]);
    const merged = await cascade.enrich(["AMZN"]);
    expect(merged.AMZN.companyName).toBe("Amazon.com, Inc.");
    expect(merged.AMZN.grossProfitMargin).toBe(Math.round((250_000 / 600_000) * 100 * 100) / 100);
    expect(merged.AMZN.sources?.companyName).toBe("simfin");
    expect(merged.AMZN.sources?.grossProfitMargin).toBe("simfin");
    expect(cascade.activeSources).toContain("simfin");
  });
});

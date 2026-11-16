import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";

beforeAll(() => {
  resetDbForTesting();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-market-custom-symbol-${randomUUID()}.db`)}`;
});

afterEach(() => {
  resetDbForTesting();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.FINNHUB_API_KEY;
  delete process.env.FMP_API_KEY;
  delete process.env.ALPHAVANTAGE_API_KEY;
  delete process.env.ALPACA_DATA_API_KEY;
  delete process.env.ALPACA_DATA_SECRET_KEY;
});

describe("market scan custom symbols", () => {
  it("keeps a quote-resolvable custom ticker even when the Nasdaq screener omits it", async () => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.ALPACA_DATA_API_KEY;
    delete process.env.ALPACA_DATA_SECRET_KEY;
    stubMarketFetches();

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket(["SPCX"], []);

    expect(scan.returnedQuotes).toBe(1);
    expect(scan.topCandidates.map((quote) => quote.symbol)).toEqual(["SPCX"]);
    expect(scan.quotesBySymbol.SPCX?.price).toBe(161.84);
    expect(scan.source).toContain("yahoo-finance");
    // Durable field store may note seed/shortfall; must not error on the custom ticker path.
    expect(scan.warnings.every((w) => !/failed|error/i.test(w))).toBe(true);
  });

  it("lists yahoo-finance as a source from the quote-only fallback even when enrichment contributes nothing", async () => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.ALPACA_DATA_API_KEY;
    delete process.env.ALPACA_DATA_SECRET_KEY;
    // The chart endpoint (quote-only price) succeeds, but the Yahoo crumb/quoteSummary enrichment path
    // 404s — so enrichment contributes no accepted field. The displayed quote still came from Yahoo, so
    // MarketScan.source must still name yahoo-finance (regression: it was reported as screener-only).
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com")) return nasdaqRows([]);
      if (url.includes("/v8/finance/chart/SPCX")) {
        return new Response(
          JSON.stringify({
            chart: { result: [{ meta: { regularMarketPrice: 161.84, chartPreviousClose: 154.6, regularMarketVolume: 2500000 }, indicators: { quote: [{ volume: [2500000] }] } }] }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 }); // crumb + quoteSummary fail → no enrichment
    });

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket(["SPCX"], []);

    expect(scan.returnedQuotes).toBe(1);
    expect(scan.quotesBySymbol.SPCX?.price).toBe(161.84);
    expect(scan.source).toContain("yahoo-finance");
  });

  it("tags the chart-endpoint (quote-only) bid/ask provenance as synthetic", async () => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.ALPACA_DATA_API_KEY;
    delete process.env.ALPACA_DATA_SECRET_KEY;
    stubMarketFetches();

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket(["SPCX"], []);

    const summary = scan.quotesBySymbol.SPCX;
    // Price is real; bid/ask are synthesized from price and must be tagged as such so
    // downstream limit-price math never treats them as a real quoted spread.
    expect(summary?.sources?.price).toBe("yahoo-finance");
    expect(summary?.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(summary?.sources?.bid).toBe("yahoo-finance-synthetic");
  });

  it("carries factor fields (factorBreakdown, volume, intraday change) on the summary tier", async () => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.ALPACA_DATA_API_KEY;
    delete process.env.ALPACA_DATA_SECRET_KEY;
    stubMarketFetches();

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket(["SPCX"], []);

    const full = scan.topCandidates[0];
    const summary = scan.quotesBySymbol.SPCX;
    // The summary tier must mirror the full quote's factor fields so the
    // drilldown can render factor bars for symbols outside topCandidates.
    expect(full.factorBreakdown).toBeDefined();
    expect(summary?.factorBreakdown).toEqual(full.factorBreakdown);
    expect(summary?.intradayChangePct).toBe(full.intradayChangePct);
    expect(summary?.volume).toBe(2500000);
    expect(summary?.sectorRelStrength).toBe(full.sectorRelStrength);
  });

  it("throws when the screener is empty, quote fallback fails, and no seed remains", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com")) return nasdaqRows([]);
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache, scanMarket, ScanQuotesUnavailableError } = await import("../src/lib/market");
    clearMarketCache();
    await expect(scanMarket(["DSADLAS"], [])).rejects.toBeInstanceOf(ScanQuotesUnavailableError);
  });
});

function stubMarketFetches(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.nasdaq.com")) return nasdaqRows([]);
    if (url.includes("/v8/finance/chart/SPCX")) {
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 161.84,
                  chartPreviousClose: 154.6,
                  regularMarketVolume: 2500000
                },
                indicators: { quote: [{ volume: [2500000] }] }
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url === "https://fc.yahoo.com") {
      return new Response("", { status: 200, headers: { "set-cookie": "B=test" } });
    }
    if (url.includes("/v1/test/getcrumb")) {
      return new Response("crumb", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("/v10/finance/quoteSummary/SPCX")) {
      return new Response(
        JSON.stringify({
          quoteSummary: {
            result: [
              {
                summaryDetail: {},
                defaultKeyStatistics: {},
                financialData: {},
                assetProfile: { sector: "Industrials", industry: "Aerospace & Defense" }
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function nasdaqRows(rows: unknown[]): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-23",
        table: { rows }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

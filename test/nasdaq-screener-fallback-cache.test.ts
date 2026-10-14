import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";

beforeAll(() => {
  resetDbForTesting();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-screener-fallback-${randomUUID()}.db`)}`;
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

function silenceProviderKeys(): void {
  delete process.env.FINNHUB_API_KEY;
  delete process.env.FMP_API_KEY;
  delete process.env.ALPHAVANTAGE_API_KEY;
  delete process.env.ALPACA_DATA_API_KEY;
  delete process.env.ALPACA_DATA_SECRET_KEY;
}

describe("nasdaq screener universe fallback", () => {
  it("does not cache price-less directory rows as a screener hit", async () => {
    silenceProviderKeys();
    let nasdaqHits = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com")) {
        nasdaqHits += 1;
        return new Response("unavailable", { status: 503 });
      }
      if (url.includes("company_tickers_exchange.json")) {
        return new Response(
          JSON.stringify({ fields: ["ticker", "title"], data: [["SPCX", "Space Exploration"]] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("nasdaqlisted.txt") || url.includes("otherlisted.txt")) {
        return new Response(
          "Symbol|Security Name|Market Category|Test Issue|Financial Status\nSPCX|Space Exploration|Q|N|N\n",
          { status: 200, headers: { "content-type": "text/plain" } }
        );
      }
      if (url.includes("/v8/finance/chart/SPCX")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [{
                meta: { regularMarketPrice: 10, chartPreviousClose: 9, regularMarketVolume: 100 },
                indicators: { quote: [{ volume: [100] }] }
              }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    const { resetProviderRateLimiterState } = await import("../src/lib/provider-rate-limit");
    clearMarketCache();
    resetProviderRateLimiterState();
    const first = await scanMarket(["SPCX"], [], undefined, undefined, [], { enrichmentMode: "skip" });
    const afterFirst = nasdaqHits;
    const second = await scanMarket(["SPCX"], [], undefined, undefined, [], { enrichmentMode: "skip" });
    expect(first.returnedQuotes).toBe(1);
    expect(second.returnedQuotes).toBe(1);
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(nasdaqHits).toBeGreaterThan(afterFirst);
  });

  it("keeps the original screener status when the universe fallback throws", async () => {
    silenceProviderKeys();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com")) return new Response("unavailable", { status: 503 });
      return new Response("missing", { status: 404 });
    });

    const { clearMarketCache, scanMarket, ScanQuotesUnavailableError } = await import("../src/lib/market");
    const { resetProviderRateLimiterState } = await import("../src/lib/provider-rate-limit");
    clearMarketCache();
    resetProviderRateLimiterState();
    await expect(scanMarket(["DSADLAS"], [], undefined, undefined, [], { enrichmentMode: "skip" })).rejects.toBeInstanceOf(ScanQuotesUnavailableError);
    try {
      await scanMarket(["DSADLAS"], [], undefined, undefined, [], { enrichmentMode: "skip" });
    } catch (error) {
      expect(error).toBeInstanceOf(ScanQuotesUnavailableError);
      const warnings = (error as InstanceType<typeof ScanQuotesUnavailableError>).warnings.join(" ");
      expect(warnings).toContain("503");
      expect(warnings).toMatch(/keyless universe fallback failed/i);
    }
  });
});

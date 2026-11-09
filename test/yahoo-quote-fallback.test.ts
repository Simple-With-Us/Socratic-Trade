import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";
import { clearMarketCache, scanMarket } from "../src/lib/market";
import { resetProviderRateLimiterState } from "../src/lib/provider-rate-limit";
import {
  __resetYahooV7AuthCooldownForTests,
  fetchYahooFinanceQuotesBatch,
  YAHOO_CHART_FALLBACK_CONCURRENCY
} from "../src/lib/yahoo-finance";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-yahoo-quote-fallback-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

beforeEach(() => {
  clearMarketCache();
  resetProviderRateLimiterState();
  __resetYahooV7AuthCooldownForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetYahooV7AuthCooldownForTests();
});

function chartResponse(symbol: string, price: number): Response {
  return new Response(
    JSON.stringify({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: price,
            chartPreviousClose: price - 1,
            regularMarketVolume: 1_000_000,
            regularMarketTime: 1_760_000_000
          },
          indicators: { quote: [{ volume: [1_000_000] }] }
        }]
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function symbols(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `TST${String(i).padStart(3, "0")}`);
}

describe("yahoo v7 auth wall (prod 2026-11-06: v7 401s, v8 chart 200s)", () => {
  it("stops calling v7 for the remaining chunks of the batch after a 401", async () => {
    let v7Calls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/v7/finance/quote")) {
        v7Calls += 1;
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    });

    // 260 symbols = 6 chunks of 50; waves of 4 fire together, so the first wave
    // (4 chunks) still goes out after the 401s land — the remaining 2 must not.
    const result = await fetchYahooFinanceQuotesBatch(symbols(260), { concurrency: 4 });
    expect(result.size).toBe(0);
    expect(v7Calls).toBe(4);
  });

  it("treats 403 like 401 and cools v7 down across batch calls until reset", async () => {
    let v7Calls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/v7/finance/quote")) {
        v7Calls += 1;
        return new Response("Forbidden", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    });

    await fetchYahooFinanceQuotesBatch(symbols(10));
    expect(v7Calls).toBe(1);
    // Second batch call: cooldown — no v7 request at all.
    await fetchYahooFinanceQuotesBatch(symbols(10));
    expect(v7Calls).toBe(1);

    __resetYahooV7AuthCooldownForTests();
    await fetchYahooFinanceQuotesBatch(symbols(10));
    expect(v7Calls).toBe(2);
  });

  it("prices the universe via chart fallback when the screener is empty and v7 401s", async () => {
    const universe = symbols(60);
    const priceBySymbol = new Map(universe.map((s, i) => [s, 100 + i]));
    let v7Calls = 0;
    let chartCalls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("api.nasdaq.com")) {
        return new Response(
          JSON.stringify({ data: { asof: "2026-11-06", table: { rows: [] } } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/v7/finance/quote")) {
        v7Calls += 1;
        return new Response("Unauthorized", { status: 401 });
      }
      const chartMatch = url.match(/\/v8\/finance\/chart\/([^?]+)/);
      if (chartMatch) {
        chartCalls += 1;
        const symbol = decodeURIComponent(chartMatch[1] ?? "");
        return chartResponse(symbol, priceBySymbol.get(symbol) ?? 100);
      }
      return new Response("not found", { status: 404 });
    });

    const scan = await scanMarket(universe, [], undefined, undefined, [], { enrichmentMode: "skip" });
    // 60 symbols = 2 chunks in a single wave of 4: both fire, then chart takes over.
    expect(v7Calls).toBe(2);
    expect(chartCalls).toBe(60);
    expect(scan.returnedQuotes).toBe(60);
    expect(Object.keys(scan.quotesBySymbol)).toHaveLength(60);
    // topCandidates is capped by the scan candidate limit; every name is priced.
    expect(scan.topCandidates.length).toBeGreaterThan(0);
    expect(scan.source).toContain("yahoo-finance");
    expect(scan.warnings.join(" ")).toMatch(/quote fallback priced 60 of 60/);
  });
});

describe("chart fallback bounded pool", () => {
  it("keeps in-flight chart fetches within the pool size for a 60-symbol universe", async () => {
    const universe = symbols(60);
    let chartInFlight = 0;
    let maxChartInFlight = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("api.nasdaq.com")) {
        return new Response(
          JSON.stringify({ data: { asof: "2026-11-06", table: { rows: [] } } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/v7/finance/quote")) {
        // v7 aborts outright (prod: 8s chunk burns through the proxy gate).
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
      const chartMatch = url.match(/\/v8\/finance\/chart\/([^?]+)/);
      if (chartMatch) {
        chartInFlight += 1;
        maxChartInFlight = Math.max(maxChartInFlight, chartInFlight);
        try {
          // Overlap window: unbounded Promise.all would park all 60 here at once.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return chartResponse(decodeURIComponent(chartMatch[1] ?? ""), 100);
        } finally {
          chartInFlight -= 1;
        }
      }
      return new Response("not found", { status: 404 });
    });

    const scan = await scanMarket(universe, [], undefined, undefined, [], { enrichmentMode: "skip" });
    expect(scan.returnedQuotes).toBe(60);
    expect(maxChartInFlight).toBeGreaterThan(1);
    expect(maxChartInFlight).toBeLessThanOrEqual(YAHOO_CHART_FALLBACK_CONCURRENCY);
    expect(YAHOO_CHART_FALLBACK_CONCURRENCY).toBe(4);
  });
});

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";
import { clearMarketCache, scanMarket } from "../src/lib/market";
import { resetProviderRateLimiterState } from "../src/lib/provider-rate-limit";
import { __resetYahooSessionCredsForTests } from "../src/lib/yahoo-session";
import {
  __resetYahooQuoteTelemetryForTests,
  __resetYahooV7AuthCooldownForTests,
  fetchYahooFinanceChartQuotes,
  fetchYahooFinanceQuote,
  fetchYahooFinanceQuotesBatch,
  peekLastYahooQuoteTelemetry,
  YAHOO_CHART_FALLBACK_CONCURRENCY
} from "../src/lib/yahoo-finance";
import { YAHOO_SESSION_HANDSHAKE_TIMEOUT_MS } from "../src/lib/yahoo-session";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-yahoo-quote-fallback-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

beforeEach(() => {
  clearMarketCache();
  resetProviderRateLimiterState();
  __resetYahooV7AuthCooldownForTests();
  __resetYahooSessionCredsForTests();
  __resetYahooQuoteTelemetryForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetYahooV7AuthCooldownForTests();
  __resetYahooSessionCredsForTests();
  __resetYahooQuoteTelemetryForTests();
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

function yahooSessionStubs(extra: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("fc.yahoo.com")) {
      return new Response("", { status: 200, headers: { "set-cookie": "A3=d=sess; Path=/" } });
    }
    if (url.includes("/v1/test/getcrumb")) {
      return new Response("testcrumb", { status: 200, headers: { "content-type": "text/plain" } });
    }
    return extra(url);
  });
}

describe("yahoo v7 auth wall (prod 2026-11-06: v7 401s, v8 chart 200s)", () => {
  it("skips v7 without burning chunk timeouts when the session handshake fails", async () => {
    let v7Calls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("fc.yahoo.com")) {
        return new Response("down", { status: 503 });
      }
      if (url.includes("/v7/finance/quote")) v7Calls += 1;
      return new Response("not found", { status: 404 });
    });

    const result = await fetchYahooFinanceQuotesBatch(symbols(20));
    expect(result.size).toBe(0);
    expect(v7Calls).toBe(0);
    expect(peekLastYahooQuoteTelemetry()?.kind).toBe("v7_session_unavailable");
  });

  it("stops calling v7 for the remaining chunks of the batch after a 401", async () => {
    let v7Calls = 0;
    yahooSessionStubs((url) => {
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
    yahooSessionStubs((url) => {
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
      if (url.includes("fc.yahoo.com")) {
        return new Response("", { status: 200, headers: { "set-cookie": "A3=d=sess; Path=/" } });
      }
      if (url.includes("/v1/test/getcrumb")) {
        return new Response("testcrumb", { status: 200 });
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

describe("yahoo v7 partial results under abort pressure", () => {
  it("returns quotes from chunks that succeed when another chunk aborts once then succeeds", async () => {
    const abortOnce = new Set(["chunk-1"]);
    yahooSessionStubs((url) => {
      if (url.includes("/v7/finance/quote")) {
        const sym = decodeURIComponent(url.match(/symbols=([^&]+)/)?.[1]?.split(",")[0] ?? "");
        if (sym.startsWith("TST0") && abortOnce.has("chunk-1")) {
          abortOnce.delete("chunk-1");
          throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        }
        const symbols = (url.match(/symbols=([^&]+)/)?.[1] ?? "")
          .split(",")
          .map((s) => decodeURIComponent(s));
        return new Response(
          JSON.stringify({
            quoteResponse: {
              result: symbols.map((symbol) => ({
                symbol,
                regularMarketPrice: 42,
                bid: 41.9,
                ask: 42.1,
                regularMarketVolume: 1
              }))
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const batch = await fetchYahooFinanceQuotesBatch(symbols(55), { concurrency: 2 });
    expect(abortOnce.size).toBe(0);
    expect(batch.size).toBeGreaterThan(40);
    const telemetry = peekLastYahooQuoteTelemetry();
    expect(telemetry?.kind).toBe("v7_batch_complete");
    expect(telemetry?.v7ChunksOk).toBe(2);
    expect(telemetry?.v7ChunksAbort ?? 0).toBe(0);
  });

  it("does not break remaining v7 waves when a chunk aborts once then succeeds", async () => {
    const abortOncePerChunk = new Map<string, boolean>();
    let abortThrows = 0;
    yahooSessionStubs((url) => {
      if (url.includes("/v7/finance/quote")) {
        const chunkKey = url.match(/symbols=([^&]+)/)?.[1] ?? "";
        if (!abortOncePerChunk.has(chunkKey)) {
          abortOncePerChunk.set(chunkKey, true);
          abortThrows += 1;
          throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        }
        const symbols = chunkKey.split(",").map((s) => decodeURIComponent(s));
        return new Response(
          JSON.stringify({
            quoteResponse: {
              result: symbols.map((symbol) => ({
                symbol,
                regularMarketPrice: 10,
                bid: 9.9,
                ask: 10.1,
                regularMarketVolume: 1
              }))
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const batch = await fetchYahooFinanceQuotesBatch(symbols(100), { concurrency: 2 });
    expect(abortThrows).toBeGreaterThanOrEqual(2);
    expect(batch.size).toBe(100);
    const telemetry = peekLastYahooQuoteTelemetry();
    expect(telemetry?.v7ChunksAbort ?? 0).toBe(0);
    expect((telemetry?.v7Chunks ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("prices v7 chunks when numeric fields arrive as strings", async () => {
    yahooSessionStubs((url) => {
      if (url.includes("/v7/finance/quote")) {
        const symbols = (url.match(/symbols=([^&]+)/)?.[1] ?? "")
          .split(",")
          .map((s) => decodeURIComponent(s));
        return new Response(
          JSON.stringify({
            quoteResponse: {
              result: symbols.map((symbol) => ({
                symbol,
                regularMarketPrice: "42.5",
                bid: "42.4",
                ask: "42.6",
                regularMarketVolume: "1000"
              }))
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    const batch = await fetchYahooFinanceQuotesBatch(["ZZZ1", "ZZZ2"]);
    expect(batch.size).toBe(2);
    expect(batch.get("ZZZ1")?.price).toBe(42.5);
  });

  it("emits v7_chunk_empty telemetry when a chunk fails with a non-abort error", async () => {
    const telemetryKinds: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      const json = line.match(/\{.*\}$/)?.[0];
      if (json) {
        try {
          const payload = JSON.parse(json) as { kind?: string };
          if (payload.kind) telemetryKinds.push(payload.kind);
        } catch {
          // ignore non-json warn lines
        }
      }
    });
    try {
      yahooSessionStubs((url) => {
        if (url.includes("/v7/finance/quote")) {
          throw new TypeError("Unexpected v7 parse failure");
        }
        return new Response("not found", { status: 404 });
      });
      const batch = await fetchYahooFinanceQuotesBatch(["FAIL1"]);
      expect(batch.size).toBe(0);
      expect(telemetryKinds).toContain("v7_chunk_empty");
      expect(peekLastYahooQuoteTelemetry()?.kind).toBe("v7_batch_complete");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("yahoo chart zod boundary", () => {
  it("accepts chart meta with null optional fields and still prices", async () => {
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/v8/finance/chart/")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [{
                meta: {
                  regularMarketPrice: 88,
                  chartPreviousClose: null,
                  trailingPE: null,
                  longName: null
                },
                indicators: { quote: [{ volume: [1] }] }
              }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    const quote = await fetchYahooFinanceQuote("NULLY");
    expect(quote?.price).toBe(88);
  });

  it("rejects malformed chart payloads before reading meta", async () => {
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/v8/finance/chart/")) {
        return new Response(JSON.stringify({ chart: { result: ["not-an-object"] } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    const quote = await fetchYahooFinanceQuote("AAPL");
    expect(quote).toBeUndefined();
  });
});

describe("yahoo session handshake timeout", () => {
  it("fails closed when fc.yahoo.com hangs until handshake timeout", async () => {
    vi.stubGlobal("fetch", (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.includes("fc.yahoo.com") || url.includes("/v1/test/getcrumb")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
          });
        });
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const batch = await fetchYahooFinanceQuotesBatch(["AAPL"]);
    expect(batch.size).toBe(0);
    expect(peekLastYahooQuoteTelemetry()?.kind).toBe("v7_session_unavailable");
  }, YAHOO_SESSION_HANDSHAKE_TIMEOUT_MS * 2 + 5_000);
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
      if (url.includes("fc.yahoo.com")) {
        return new Response("", { status: 200, headers: { "set-cookie": "A3=d=sess; Path=/" } });
      }
      if (url.includes("/v1/test/getcrumb")) {
        return new Response("testcrumb", { status: 200 });
      }
      if (url.includes("/v7/finance/quote")) {
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
    expect(maxChartInFlight).toBeGreaterThanOrEqual(1);
    expect(maxChartInFlight).toBeLessThanOrEqual(YAHOO_CHART_FALLBACK_CONCURRENCY);
    expect(YAHOO_CHART_FALLBACK_CONCURRENCY).toBe(4);
  });
});

describe("chart fallback cancellation", () => {
  it("stops launching further chart requests once the signal aborts", async () => {
    const universe = symbols(60);
    const controller = new AbortController();
    let chartCalls = 0;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
      const url = String(request);
      const chartMatch = url.match(/\/v8\/finance\/chart\/([^?]+)/);
      if (chartMatch) {
        chartCalls += 1;
        // Abort mid-flight: the already-launched first wave settles, the rest must not launch.
        if (chartCalls === 2) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return chartResponse(decodeURIComponent(chartMatch[1] ?? ""), 100);
      }
      return new Response("not found", { status: 404 });
    });

    const result = await fetchYahooFinanceChartQuotes(universe, { signal: controller.signal });
    expect(chartCalls).toBeLessThan(universe.length);
    expect(chartCalls).toBeLessThanOrEqual(2 * YAHOO_CHART_FALLBACK_CONCURRENCY);
    expect(result.size).toBeLessThanOrEqual(chartCalls);
  });
});

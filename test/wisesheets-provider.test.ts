import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors test/quiver-provider.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-wisesheets-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

describe("Wisesheets enrichment provider", () => {
  const originalKey = process.env.WISESHEETS_API_KEY;
  const originalTtl = process.env.WISESHEETS_CACHE_TTL_MS;
  const originalNegTtl = process.env.WISESHEETS_NEGATIVE_CACHE_TTL_MS;

  beforeEach(async () => {
    delete process.env.WISESHEETS_API_KEY;
    delete process.env.WISESHEETS_CACHE_TTL_MS;
    delete process.env.WISESHEETS_NEGATIVE_CACHE_TTL_MS;
    const { clearWisesheetsCache } = await import("../src/lib/wisesheets-provider");
    clearWisesheetsCache();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalKey) process.env.WISESHEETS_API_KEY = originalKey;
    else delete process.env.WISESHEETS_API_KEY;
    if (originalTtl) process.env.WISESHEETS_CACHE_TTL_MS = originalTtl;
    else delete process.env.WISESHEETS_CACHE_TTL_MS;
    if (originalNegTtl) process.env.WISESHEETS_NEGATIVE_CACHE_TTL_MS = originalNegTtl;
    else delete process.env.WISESHEETS_NEGATIVE_CACHE_TTL_MS;
    const { clearWisesheetsCache } = await import("../src/lib/wisesheets-provider");
    clearWisesheetsCache();
    vi.unstubAllGlobals();
  });

  // ── Key resolution ──────────────────────────────────────────────────────────

  it("resolveWisesheetsApiKey trims whitespace and treats blank as unset", async () => {
    const { resolveWisesheetsApiKey } = await import("../src/lib/wisesheets-provider");
    process.env.WISESHEETS_API_KEY = "  test_wisesheets_key  ";
    expect(resolveWisesheetsApiKey()).toBe("test_wisesheets_key");
    process.env.WISESHEETS_API_KEY = "   ";
    expect(resolveWisesheetsApiKey()).toBeUndefined();
    delete process.env.WISESHEETS_API_KEY;
    expect(resolveWisesheetsApiKey()).toBeUndefined();
  });

  it("is registered by the shared cascade when WISESHEETS_API_KEY is set, dormant otherwise", async () => {
    delete process.env.WISESHEETS_API_KEY;
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    expect(getEnrichmentProvider().name).not.toContain("wisesheets");

    process.env.WISESHEETS_API_KEY = "test-key";
    expect(getEnrichmentProvider().name).toContain("wisesheets");
    delete process.env.WISESHEETS_API_KEY;
  });

  // ── Row extraction (real observed envelope shape: { data: [...], meta: {...} }) ──────────

  it("extractWisesheetsRows reads the documented envelope and tolerates malformed/empty payloads", async () => {
    const { extractWisesheetsRows } = await import("../src/lib/wisesheets-provider");
    expect(extractWisesheetsRows({ data: [{ symbol: "AAPL" }], meta: { returned: 1 } })).toHaveLength(1);
    expect(extractWisesheetsRows({ data: [] })).toEqual([]);
    expect(extractWisesheetsRows(null)).toEqual([]);
    expect(extractWisesheetsRows(undefined)).toEqual([]);
    expect(extractWisesheetsRows("not json")).toEqual([]);
    expect(extractWisesheetsRows({ error: { code: "AUTH_MISSING" } })).toEqual([]);
    // data present but not an array (malformed) -> empty, never thrown
    expect(extractWisesheetsRows({ data: "oops" })).toEqual([]);
  });

  // ── Live-prices parsing (real observed row shape from GET /v1/prices/live) ───────────────

  it("parseLiveQuotes maps the documented live-quote fields, parsing string-serialized numbers", async () => {
    const { parseLiveQuotes } = await import("../src/lib/wisesheets-provider");
    const rows = [
      {
        symbol: "AAPL",
        price: "190.12",
        change: "1.25",
        changesPercentage: "0.66",
        volume: "48213000",
        yearHigh: "199.62",
        yearLow: "164.08",
        eps: "6.97",
        pe: "31.4",
        name: "Apple Inc.",
        timestamp: 1710000000
      }
    ];
    const out = parseLiveQuotes(rows);
    expect(out.AAPL).toEqual({
      price: 190.12,
      peRatio: 31.4,
      eps: 6.97,
      volume: 48213000,
      fiftyTwoWeekHigh: 199.62,
      fiftyTwoWeekLow: 164.08,
      intradayChangePct: 0.66,
      companyName: "Apple Inc.",
      asOf: new Date(1710000000 * 1000).toISOString()
    });
  });

  it("parseLiveQuotes never fabricates a P/E for a non-positive or missing value, and skips rows with no symbol", async () => {
    const { parseLiveQuotes } = await import("../src/lib/wisesheets-provider");
    const out = parseLiveQuotes([
      { symbol: "TSLA", price: "250", pe: "-12.4", eps: "-3.1", volume: "0" },
      { price: "1", eps: "1" } // no symbol -> dropped entirely
    ]);
    expect(out.TSLA.peRatio).toBeUndefined(); // negative P/E is a real "no ratio" state, not surfaced
    expect(out.TSLA.eps).toBe(-3.1); // EPS itself CAN be negative — that's real data
    expect(out.TSLA.volume).toBeUndefined(); // zero volume filtered like other providers in this cascade
    expect(Object.keys(out)).toEqual(["TSLA"]);
  });

  // ── Financials parsing (real observed row shape from GET /v1/financials/) ────────────────

  it("parseFinancialsBySymbol computes YoY revenueGrowth from the two most recent annual `revenue` rows and reads `gross_margin` directly", async () => {
    const { parseFinancialsBySymbol } = await import("../src/lib/wisesheets-provider");
    const rows = [
      { ticker: "AAPL", metric: "revenue", periodEnd: "2025-09-27", fiscalYear: 2025, value: "416161000000", unit: "USD" },
      { ticker: "AAPL", metric: "revenue", periodEnd: "2024-09-28", fiscalYear: 2024, value: "391035000000", unit: "USD" },
      { ticker: "AAPL", metric: "revenue", periodEnd: "2023-09-30", fiscalYear: 2023, value: "383285000000", unit: "USD" },
      { ticker: "AAPL", metric: "gross_margin", periodEnd: "2025-09-27", fiscalYear: 2025, value: "0.4675", unit: "ratio" }
    ];
    const out = parseFinancialsBySymbol(rows);
    const expectedGrowth = Math.round(((416161000000 - 391035000000) / 391035000000) * 10000) / 100;
    expect(out.AAPL.revenueGrowth).toBe(expectedGrowth);
    expect(out.AAPL.grossProfitMargin).toBe(46.75); // 0.4675 fraction -> 46.75%
  });

  it("parseFinancialsBySymbol omits revenueGrowth when only one annual period is available, and never divides by a zero prior value", async () => {
    const { parseFinancialsBySymbol } = await import("../src/lib/wisesheets-provider");
    const singlePeriod = parseFinancialsBySymbol([
      { ticker: "NEWCO", metric: "revenue", periodEnd: "2025-12-31", fiscalYear: 2025, value: "1000" }
    ]);
    expect(singlePeriod.NEWCO).toBeUndefined();

    const zeroPrior = parseFinancialsBySymbol([
      { ticker: "SPINCO", metric: "revenue", periodEnd: "2025-12-31", fiscalYear: 2025, value: "5000" },
      { ticker: "SPINCO", metric: "revenue", periodEnd: "2024-12-31", fiscalYear: 2024, value: "0" }
    ]);
    expect(zeroPrior.SPINCO?.revenueGrowth).toBeUndefined();
  });

  it("parseFinancialsBySymbol tolerates malformed rows (missing ticker, missing value, unknown metric)", async () => {
    const { parseFinancialsBySymbol } = await import("../src/lib/wisesheets-provider");
    const out = parseFinancialsBySymbol([
      { metric: "revenue", value: "100" }, // no ticker -> dropped
      { ticker: "AAPL", metric: "revenue", value: null }, // unparseable value -> dropped
      { ticker: "AAPL", metric: "some_unmapped_metric", value: "5" } // not one we map -> ignored
    ]);
    expect(out).toEqual({});
  });

  // ── Dividend-yield computation (real observed row shape from GET /v1/dividends/) ─────────

  it("computeDividendYields sums trailing adjDividend and divides by price", async () => {
    const { computeDividendYields } = await import("../src/lib/wisesheets-provider");
    const rows = [
      { symbol: "AAPL", date: "2025-11-10", adjDividend: "0.26" },
      { symbol: "AAPL", date: "2025-08-11", adjDividend: "0.26" },
      { symbol: "AAPL", date: "2025-05-12", adjDividend: "0.26" },
      { symbol: "AAPL", date: "2025-02-10", adjDividend: "0.24" }
    ];
    const out = computeDividendYields(rows, ["AAPL"], { AAPL: 190.12 });
    const expectedYield = Math.round(((0.26 + 0.26 + 0.26 + 0.24) / 190.12) * 10000) / 100;
    expect(out.AAPL).toBe(expectedYield);
  });

  it("computeDividendYields yields a real 0% for a confirmed non-payer still present in the requested batch, and omits a symbol with unknown price", async () => {
    const { computeDividendYields } = await import("../src/lib/wisesheets-provider");
    // TSLA requested but absent from `rows` entirely — the documented "missingSymbols/non-payer"
    // case. A real computed 0, never a fabricated placeholder.
    const out = computeDividendYields([], ["TSLA", "NOPRICE"], { TSLA: 250, NOPRICE: undefined });
    expect(out.TSLA).toBe(0);
    expect(out.NOPRICE).toBeUndefined();
  });

  // ── Provider enrich() behavior: fetch wiring, caching, fail-open ─────────────────────────

  function stubThreeEndpoints(handlers: {
    live?: unknown[] | Error;
    dividends?: unknown[] | Error;
    financials?: unknown[] | Error;
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        let value: unknown[] | Error | undefined;
        if (url.includes("/prices/live")) value = handlers.live;
        else if (url.includes("/dividends/")) value = handlers.dividends;
        else if (url.includes("/financials/")) value = handlers.financials;
        if (value instanceof Error) throw value;
        return new Response(JSON.stringify({ data: value ?? [], meta: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );
  }

  it("enrich() combines all three endpoints into one merged SymbolEnrichment per symbol", async () => {
    stubThreeEndpoints({
      live: [{ symbol: "AAPL", price: "190.12", pe: "31.4", eps: "6.97", name: "Apple Inc." }],
      dividends: [{ symbol: "AAPL", date: "2025-11-10", adjDividend: "1.02" }],
      financials: [
        { ticker: "AAPL", metric: "revenue", fiscalYear: 2025, periodEnd: "2025-09-27", value: "416161000000" },
        { ticker: "AAPL", metric: "revenue", fiscalYear: 2024, periodEnd: "2024-09-28", value: "391035000000" },
        { ticker: "AAPL", metric: "gross_margin", fiscalYear: 2025, periodEnd: "2025-09-27", value: "46.75" }
      ]
    });
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    const out = await provider.enrich(["AAPL"]);
    expect(out.AAPL.price).toBe(190.12);
    expect(out.AAPL.peRatio).toBe(31.4);
    expect(out.AAPL.eps).toBe(6.97);
    expect(out.AAPL.companyName).toBe("Apple Inc.");
    expect(out.AAPL.dividendYield).toBeCloseTo((1.02 / 190.12) * 100, 2);
    expect(out.AAPL.grossProfitMargin).toBe(46.75);
    expect(out.AAPL.revenueGrowth).toBeCloseTo(((416161000000 - 391035000000) / 391035000000) * 100, 2);
  });

  it("caches a fully successful batch and does not refetch within the TTL", async () => {
    stubThreeEndpoints({
      live: [{ symbol: "MSFT", price: "420", pe: "35.8" }],
      dividends: [],
      financials: []
    });
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    await provider.enrich(["MSFT"]);
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(3); // one call per endpoint
    await provider.enrich(["MSFT"]);
    const callsAfterSecond = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // served entirely from cache
  });

  it("fails open on a partial failure: surfaces the endpoints that succeeded and omits fields from the one that didn't", async () => {
    stubThreeEndpoints({
      live: [{ symbol: "NFLX", price: "900", pe: "36.4" }],
      dividends: new Error("network down"),
      financials: [{ ticker: "NFLX", metric: "gross_margin", fiscalYear: 2025, periodEnd: "2025-12-31", value: "44.1" }]
    });
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    const out = await provider.enrich(["NFLX"]);
    expect(out.NFLX.price).toBe(900);
    expect(out.NFLX.grossProfitMargin).toBe(44.1);
    expect(out.NFLX.dividendYield).toBeUndefined(); // dividends fetch failed -> never guessed
  });

  it("never throws out of enrich() even when every endpoint fails (fail-open)", async () => {
    stubThreeEndpoints({
      live: new Error("total outage"),
      dividends: new Error("total outage"),
      financials: new Error("total outage")
    });
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    const out = await provider.enrich(["GME"]);
    expect(out.GME).toEqual({});
  });

  it("caches a partial-failure result under the shorter negative TTL and retries sooner than the positive floor", async () => {
    process.env.WISESHEETS_NEGATIVE_CACHE_TTL_MS = "1"; // effectively immediate re-eligibility
    let liveCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/prices/live")) {
          liveCalls++;
          throw new Error("network down");
        }
        return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
      })
    );
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    await provider.enrich(["ORCL"]);
    expect(liveCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.enrich(["ORCL"]);
    expect(liveCalls).toBe(2);
  });

  it("treats a 404 (unrecognized ticker) as empty data rather than a lane failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 }))
    );
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    const out = await provider.enrich(["FAKE999"]);
    expect(out.FAKE999).toEqual({});
  });

  // ── Cascade integration: a produced value flows through takeScalar with correct source attribution ──

  it("a Wisesheets-produced value flows through CascadingEnrichmentProvider's takeScalar into the merged SymbolEnrichment", async () => {
    stubThreeEndpoints({
      live: [{ symbol: "AMZN", price: "230", pe: "40.5", eps: "5.29", name: "Amazon.com, Inc." }],
      dividends: [],
      financials: []
    });
    const { WisesheetsEnrichmentProvider } = await import("../src/lib/wisesheets-provider");
    const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = new WisesheetsEnrichmentProvider("test-key");
    const cascade = new CascadingEnrichmentProvider([provider]);
    const merged = await cascade.enrich(["AMZN"]);
    expect(merged.AMZN.peRatio).toBe(40.5);
    expect(merged.AMZN.companyName).toBe("Amazon.com, Inc.");
    expect(merged.AMZN.sources?.peRatio).toBe("wisesheets");
    expect(cascade.activeSources).toContain("wisesheets");
  });
});

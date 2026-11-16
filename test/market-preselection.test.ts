import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";
import { buildEnrichmentPreselectionPool, clearMarketCache, scanMarket } from "../src/lib/market";
import type { MarketQuote, ScoringWeights } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  enrich: vi.fn(),
  signals: {} as Record<string, { bulletins: string[]; insiderSentiment?: number }>
}));

vi.mock("../src/lib/data-providers", () => ({
  getEnrichmentProvider: () => ({
    name: "test-enrichment",
    configured: true,
    activeSources: ["test-enrichment"],
    enrich: mocks.enrich
  }),
  // scanMarket now fetches the Nasdaq screener through fetchWithRetry.  Tests
  // stub global fetch with nasdaqRows(); forward so those stubs still apply.
  fetchWithRetry: async (url: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch(url as string, init)
}));

vi.mock("../src/lib/web-sources", () => ({
  getSymbolWebSignals: () => mocks.signals,
  setTechnicalWatchlist: vi.fn()
}));

vi.mock("../src/lib/congress-share", () => ({ shareScanRefs: vi.fn() }));

const promotionWeights: ScoringWeights = {
  liquidity: 0,
  momentum: 1,
  value: 0,
  quality: 0,
  volatility: 0,
  sentiment: 1,
  positioning: 0,
  diversification: 0
};


beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-market-preselection-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

beforeEach(() => {
  clearMarketCache();
  resetDbForTesting();
  mocks.enrich.mockReset().mockResolvedValue({});
  mocks.signals = {};
  delete process.env.MARKET_SCAN_ENRICHMENT_POOL_MULTIPLIER;
  delete process.env.MARKET_SCAN_ENRICHMENT_POOL_CAP;
  vi.stubGlobal("fetch", async () => nasdaqRows([]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MARKET_SCAN_ENRICHMENT_POOL_MULTIPLIER;
  delete process.env.MARKET_SCAN_ENRICHMENT_POOL_CAP;
});

describe("two-stage market enrichment", () => {
  it("promotes an initially below-cutoff name after one wider batched enrichment call", async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) => screenerRow(`TOP${index}`, 5)),
      screenerRow("BOOST", -5)
    ];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));
    mocks.enrich.mockResolvedValue({ BOOST: { sentiment: 100, sources: { sentiment: "test-enrichment" } } });

    const scan = await scanMarket(rows.map((row) => String(row.symbol)), [], promotionWeights, undefined, [], {
      candidateLimit: 10,
      outlierReserve: 0
    });

    expect(mocks.enrich).toHaveBeenCalledTimes(1);
    expect(mocks.enrich).toHaveBeenCalledWith(
      expect.arrayContaining(["BOOST"]),
      expect.objectContaining({ signal: undefined })
    );
    expect(scan.topCandidates).toHaveLength(10);
    expect(scan.topCandidates.map((quote) => quote.symbol)).toContain("BOOST");
    expect(scan.source).toContain("test-enrichment");
  });

  it("keeps holdings in the final candidates and gives them provider-budget priority", async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) => screenerRow(`TOP${index}`, 5)),
      screenerRow("HELD", -10)
    ];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));

    const scan = await scanMarket(
      rows.map((row) => String(row.symbol)),
      [{ symbol: "HELD", marketValue: 1_000 } as never],
      promotionWeights,
      undefined,
      [],
      { candidateLimit: 10, outlierReserve: 0 }
    );

    expect(mocks.enrich).toHaveBeenCalledTimes(1);
    expect(mocks.enrich.mock.calls[0]?.[0]?.[0]).toBe("HELD");
    expect(scan.topCandidates.map((quote) => quote.symbol)).toContain("HELD");
    expect(scan.topCandidates).toHaveLength(11);
  });

  it("keeps the event reserve additive and prioritizes it when no holding is ahead of it", async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) => screenerRow(`TOP${index}`, 6)),
      screenerRow("EVENT", -10)
    ];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));
    mocks.signals = { EVENT: { insiderSentiment: 80, bulletins: [] } };

    const scan = await scanMarket(rows.map((row) => String(row.symbol)), [], promotionWeights, undefined, [], {
      candidateLimit: 10,
      outlierReserve: 1
    });

    expect(mocks.enrich.mock.calls[0]?.[0]?.[0]).toBe("EVENT");
    expect(scan.outlierCandidateCount).toBe(1);
    expect(scan.topCandidates.map((quote) => quote.symbol)).toContain("EVENT");
    expect(scan.topCandidates).toHaveLength(11);
  });

  it("returns a usable interactive scan without starting the deep provider cascade", async () => {
    const rows = [screenerRow("FAST", 2)];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));

    const scan = await scanMarket(["FAST"], [], promotionWeights, undefined, [], {
      candidateLimit: 10,
      outlierReserve: 0,
      enrichmentMode: "skip"
    });

    expect(mocks.enrich).not.toHaveBeenCalled();
    expect(scan.topCandidates.map((quote) => quote.symbol)).toEqual(["FAST"]);
    expect(scan.warnings.join(" ")).toMatch(
      /Deep fundamentals refresh is deferred|Slow fundamentals reuse the durable field store/
    );
  });

  it("reuses persisted slow facts while preserving fresh interactive price data", async () => {
    const rows = [screenerRow("FAST", 2)];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));

    const scan = await scanMarket(["FAST"], [], promotionWeights, undefined, [], {
      candidateLimit: 10,
      outlierReserve: 0,
      enrichmentMode: "skip",
      seedEnrichment: {
        FAST: {
          symbol: "FAST",
          companyName: "Fast Industries",
          price: 10,
          score: 1,
          peRatio: 15,
          sentiment: 100,
          insiderSentiment: 100,
          daysToEarnings: 1,
          intradayChangePct: -20,
          volume: 2,
          sources: {
            price: "old-price",
            intradayChangePct: "old-price",
            volume: "old-price",
            peRatio: "fmp",
            companyName: "fmp"
          }
        }
      }
    });

    const refreshed = scan.topCandidates[0]!;
    expect(mocks.enrich).not.toHaveBeenCalled();
    expect(refreshed).toMatchObject({
      symbol: "FAST",
      companyName: "Fast Industries",
      price: 100,
      volume: 1_000_000,
      intradayChangePct: 2,
      peRatio: 15
    });
    expect(refreshed.provider).toBe("nasdaq-delayed-screener");
    expect(refreshed.sources).toMatchObject({ peRatio: "fmp", companyName: "fmp" });
    expect(refreshed.sources?.price).not.toBe("old-price");
    expect(refreshed.sources?.intradayChangePct).not.toBe("old-price");
    expect(refreshed.sources?.volume).not.toBe("old-price");
    expect(refreshed.sentiment).toBeUndefined();
    expect(refreshed.insiderSentiment).toBeUndefined();
    expect(refreshed.daysToEarnings).toBeUndefined();
    expect(refreshed.factorBreakdown?.weightedTotal).toBeGreaterThan(0);
    expect(scan.warnings.join(" ")).toMatch(/durable field store|latest completed strategy scan/);
  });

  it("returns a clearly stale persisted scan when the live Nasdaq screener is unavailable", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("Nasdaq unavailable"); });

    const scan = await scanMarket(["FAST"], [], promotionWeights, undefined, [], {
      candidateLimit: 10,
      outlierReserve: 0,
      enrichmentMode: "skip",
      seedEnrichment: {
        FAST: {
          symbol: "FAST",
          companyName: "Fast Industries",
          price: 91,
          score: 44,
          peRatio: 15,
          intradayChangePct: -1,
          volume: 50_000,
          asOf: "2026-07-14T20:00:00.000Z",
          sources: { peRatio: "fmp" }
        }
      }
    });

    expect(mocks.enrich).not.toHaveBeenCalled();
    expect(scan.topCandidates[0]).toMatchObject({
      symbol: "FAST",
      companyName: "Fast Industries",
      price: 91,
      volume: 50_000,
      cached: true,
      provider: "persisted-strategy-scan",
      peRatio: 15
    });
    expect(scan.warnings.join(" ")).toContain("stale fallback");
  });

  it("holds the wider pool to the configured hard cap after prioritizing holdings and events", () => {
    process.env.MARKET_SCAN_ENRICHMENT_POOL_MULTIPLIER = "10";
    process.env.MARKET_SCAN_ENRICHMENT_POOL_CAP = "20";
    const ranked = Array.from({ length: 80 }, (_, index) => quote(`R${String(index).padStart(2, "0")}`));
    const events = [ranked[40]!, ranked[50]!];
    const pool = buildEnrichmentPreselectionPool(ranked, events, new Set(["R60", "R70"]), 10);

    expect(pool).toHaveLength(20);
    expect(pool.slice(0, 4).map((quote) => quote.symbol)).toEqual(["R60", "R70", "R40", "R50"]);
    expect(new Set(pool.map((quote) => quote.symbol)).size).toBe(pool.length);
  });

  it("honors a gather-budget pool cap override without dropping the candidate cut", () => {
    const ranked = Array.from({ length: 80 }, (_, index) => quote(`R${index}`));
    const pool = buildEnrichmentPreselectionPool(ranked, [], new Set(), 10, 10);
    expect(pool).toHaveLength(10);
  });

  it("returns the ranked Nasdaq tape when enrichment aborts instead of throwing it away", async () => {
    const rows = [screenerRow("AAPL", 1), screenerRow("MSFT", 0.5)];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));
    const controller = new AbortController();
    mocks.enrich.mockImplementation(async () => {
      controller.abort(new Error("strategy gather timeout"));
      throw new Error("strategy gather timeout");
    });
    const scan = await scanMarket(["AAPL", "MSFT"], [], promotionWeights, undefined, [], {
      candidateLimit: 2,
      outlierReserve: 0,
      signal: controller.signal
    });
    expect(scan.topCandidates.map((quote) => quote.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(scan.warnings.join(" ")).toMatch(/aborted/i);
  });

  it("skips live enrichment when the gather deadline is already past", async () => {
    const rows = [screenerRow("AAPL", 1), screenerRow("MSFT", 0.5)];
    vi.stubGlobal("fetch", async () => nasdaqRows(rows));
    const scan = await scanMarket(
      ["AAPL", "MSFT"],
      [],
      promotionWeights,
      undefined,
      [],
      { candidateLimit: 2, outlierReserve: 0, deadlineAt: Date.now() - 1_000 }
    );
    expect(mocks.enrich).not.toHaveBeenCalled();
    expect(scan.warnings.join(" ")).toMatch(/Live enrichment skipped/);
  });
});

function screenerRow(symbol: string, pctchange: number): Record<string, string> {
  return {
    symbol,
    name: `${symbol} Corp`,
    lastsale: "$100",
    netchange: "1",
    pctchange: `${pctchange}%`,
    marketCap: "1000000000",
    volume: "1000000"
  };
}

function nasdaqRows(rows: unknown[]): Response {
  return new Response(
    JSON.stringify({ data: { asof: "2026-07-13", table: { rows } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function quote(symbol: string): MarketQuote {
  return { symbol, price: 100, volume: 1_000_000, intradayChangePct: 0, positionMarketValue: 0, score: 50 };
}

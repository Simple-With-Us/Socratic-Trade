import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors the pattern in test/marketaux-provider.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-polymarket-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

// Realistic response shape, restructured from the live-verified gamma-api.polymarket.com
// /public-search response (fetched 2026-08-12) — field names, nesting, and types are real
// (outcomes/outcomePrices are JSON-ENCODED STRINGS, index-aligned); question text is synthetic.
function fixtureMarket(overrides: {
  question: string;
  outcomes?: string[];
  outcomePrices?: string[];
  volume?: number | string;
  volume24hr?: number | null;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
}) {
  return {
    id: randomUUID(),
    question: overrides.question,
    outcomes: JSON.stringify(overrides.outcomes ?? ["Yes", "No"]),
    outcomePrices: JSON.stringify(overrides.outcomePrices ?? ["0.5", "0.5"]),
    volume: overrides.volume ?? 10_000,
    volume24hr: overrides.volume24hr === undefined ? 500 : overrides.volume24hr,
    active: overrides.active ?? true,
    closed: overrides.closed ?? false,
    archived: overrides.archived ?? false
  };
}

function fixtureSearchResponse(markets: ReturnType<typeof fixtureMarket>[]) {
  return {
    events: markets.map((m) => ({ id: randomUUID(), title: m.question, markets: [m] })),
    pagination: { hasMore: false, totalResults: markets.length }
  };
}

describe("polymarket-provider", () => {
  const originalContext = process.env.POLYMARKET_CONTEXT;
  const originalMinRelevance = process.env.POLYMARKET_MIN_RELEVANCE;
  const originalTtl = process.env.POLYMARKET_CACHE_TTL_MS;
  const originalMaxSymbols = process.env.POLYMARKET_MAX_SYMBOLS_PER_RUN;

  beforeEach(async () => {
    delete process.env.POLYMARKET_CONTEXT;
    delete process.env.POLYMARKET_MIN_RELEVANCE;
    delete process.env.POLYMARKET_CACHE_TTL_MS;
    delete process.env.POLYMARKET_MAX_SYMBOLS_PER_RUN;
    const { clearPolymarketCache } = await import("../src/lib/polymarket-provider");
    clearPolymarketCache();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalContext) process.env.POLYMARKET_CONTEXT = originalContext;
    else delete process.env.POLYMARKET_CONTEXT;
    if (originalMinRelevance) process.env.POLYMARKET_MIN_RELEVANCE = originalMinRelevance;
    else delete process.env.POLYMARKET_MIN_RELEVANCE;
    if (originalTtl) process.env.POLYMARKET_CACHE_TTL_MS = originalTtl;
    else delete process.env.POLYMARKET_CACHE_TTL_MS;
    if (originalMaxSymbols) process.env.POLYMARKET_MAX_SYMBOLS_PER_RUN = originalMaxSymbols;
    else delete process.env.POLYMARKET_MAX_SYMBOLS_PER_RUN;
    const { clearPolymarketCache } = await import("../src/lib/polymarket-provider");
    clearPolymarketCache();
    vi.unstubAllGlobals();
  });

  // ── Parsing helpers ──────────────────────────────────────────────────────────

  it("extractGammaMarkets accepts the documented { events: [{ markets: [...] }] } envelope and tolerates malformed payloads", async () => {
    const { extractGammaMarkets } = await import("../src/lib/polymarket-provider");
    expect(extractGammaMarkets(fixtureSearchResponse([fixtureMarket({ question: "a" }), fixtureMarket({ question: "b" })]))).toHaveLength(2);
    expect(extractGammaMarkets(null)).toEqual([]);
    expect(extractGammaMarkets(undefined)).toEqual([]);
    expect(extractGammaMarkets("not json")).toEqual([]);
    expect(extractGammaMarkets({})).toEqual([]);
    expect(extractGammaMarkets({ events: null })).toEqual([]);
    expect(extractGammaMarkets({ events: [null, "x", { markets: null }, { markets: [null, 42, { question: "keep me" }] }] })).toEqual([
      { question: "keep me" }
    ]);
  });

  // ── fetchPolymarketContextForSymbols wiring ─────────────────────────────────

  function stubSearchEndpoint(byQuery: (query: string) => ReturnType<typeof fixtureMarket>[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const match = /[?&]q=([^&]+)/.exec(url);
        const query = match ? decodeURIComponent(match[1]) : "";
        return new Response(JSON.stringify(fixtureSearchResponse(byQuery(query))), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );
  }

  it("AAPL matches an Apple-earnings market (ticker/company-name relevance, corroborated)", async () => {
    stubSearchEndpoint(() => [
      fixtureMarket({ question: "Will Apple beat earnings estimates this quarter?", outcomePrices: ["0.62", "0.38"] })
    ]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out.AAPL).toHaveLength(1);
    expect(out.AAPL[0].question).toBe("Will Apple beat earnings estimates this quarter?");
    expect(out.AAPL[0].impliedProbabilityPct).toBe(62);
    expect(out.AAPL[0].outcomeLabel).toBe("Yes");
  });

  it("parses a decimal-STRING volume (the live-verified shape) into a numeric volumeTotal", async () => {
    stubSearchEndpoint(() => [
      fixtureMarket({ question: "Will Apple beat earnings estimates this quarter?", volume: "268663.894" })
    ]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out.AAPL[0].volumeTotal).toBeCloseTo(268_663.894, 3);
  });

  // Note: this uses TGT/"Target" rather than META/"Meta" — Meta Platforms' own TICKER (META)
  // case-insensitively word-matches the bare word "Meta" in ordinary prose, so a META-ticker
  // headline mentioning "Meta" always clears the relevance bar via the TICKER signal alone
  // (verified live against scoreHeadlineRelevance) and never actually exercises the ambiguous
  // company-NAME corroboration gate this test targets. TGT/"Target" is the same
  // AMBIGUOUS_COMPANY_NAMES gate (news-relevance.ts) with a ticker that doesn't collide with the
  // ambiguous word, matching that file's own test precedent (test/news-relevance.test.ts).
  it("an ambiguous company name ('Target') without a corroborating finance term is dropped", async () => {
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Target open 50 new stores in 2026?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["TGT"], { TGT: "Target" });
    expect(out.TGT).toBeUndefined();
  });

  it("an ambiguous company name ('Target') WITH a corroborating finance term is kept", async () => {
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Target's SEC filing reveal a data breach in 2026?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["TGT"], { TGT: "Target" });
    expect(out.TGT).toHaveLength(1);
  });

  it("a market with no textual relevance to the symbol/company is dropped", async () => {
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will it rain in London on Friday?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out.AAPL).toBeUndefined();
  });

  it("a symbol with zero matching markets contributes nothing — no key, not an empty array", async () => {
    stubSearchEndpoint(() => []);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["ZZZZ"], {});
    expect(Object.prototype.hasOwnProperty.call(out, "ZZZZ")).toBe(false);
  });

  it("keeps at most MAX_MARKETS_PER_SYMBOL markets, sorted by relevance then 24h volume", async () => {
    stubSearchEndpoint(() => [
      fixtureMarket({ question: "AAPL closes above $250 on Friday?", volume24hr: 100 }),
      fixtureMarket({ question: "AAPL closes above $260 on Friday?", volume24hr: 900 }),
      fixtureMarket({ question: "AAPL closes above $270 on Friday?", volume24hr: 500 }),
      fixtureMarket({ question: "AAPL closes above $280 on Friday?", volume24hr: 50 })
    ]);
    const { fetchPolymarketContextForSymbols, MAX_MARKETS_PER_SYMBOL } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out.AAPL).toHaveLength(MAX_MARKETS_PER_SYMBOL);
    // Same relevance score (bare ticker match for all four) — tie-broken by 24h volume desc.
    expect(out.AAPL.map((m) => m.volume24h)).toEqual([900, 500, 100]);
  });

  it("drops a closed/archived/inactive market even when its question text matches", async () => {
    stubSearchEndpoint(() => [
      fixtureMarket({ question: "AAPL closes above $250?", closed: true }),
      fixtureMarket({ question: "AAPL closes above $260?", archived: true }),
      fixtureMarket({ question: "AAPL closes above $270?", active: false })
    ]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out.AAPL).toBeUndefined();
  });

  // ── POLYMARKET_MIN_RELEVANCE gating ─────────────────────────────────────────

  it("respects a raised POLYMARKET_MIN_RELEVANCE threshold", async () => {
    process.env.POLYMARKET_MIN_RELEVANCE = "0.9"; // ambiguous-name-with-corroboration scores 0.55 — below 0.9
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Target's SEC filing reveal a data breach in 2026?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["TGT"], { TGT: "Target" });
    expect(out.TGT).toBeUndefined();
  });

  // ── POLYMARKET_CONTEXT knob: off means no fetch at all ──────────────────────

  it("POLYMARKET_CONTEXT=off fetches nothing and returns {}", async () => {
    process.env.POLYMARKET_CONTEXT = "0";
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Apple beat earnings estimates?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out).toEqual({});
    expect((global.fetch as ReturnType<typeof vi.fn> | undefined)?.mock.calls.length ?? 0).toBe(0);
  });

  // ── TTL cache ────────────────────────────────────────────────────────────────

  it("caches a successful fetch per query and does not refetch within the TTL", async () => {
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Apple beat earnings estimates?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(1);
    await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst); // served from cache
  });

  it("refetches after the TTL elapses (cache expiry, not just per-query keying)", async () => {
    process.env.POLYMARKET_CACHE_TTL_MS = "1";
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Apple beat earnings estimates?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // Let the 1ms TTL lapse, then repeat the identical query — a live cache entry would still
    // serve this from memory; an expired one must hit the network again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("does not reuse the cache across different query text (different company name)", async () => {
    stubSearchEndpoint(() => [fixtureMarket({ question: "Will Apple beat earnings estimates?" })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    await fetchPolymarketContextForSymbols(["MSFT"], { MSFT: "Microsoft" });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  // ── Fail-open ────────────────────────────────────────────────────────────────

  it("never throws on a non-ok HTTP response and yields no data for that symbol", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Internal Server Error", { status: 500 })));
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out).toEqual({});
  });

  it("never throws on a total transport failure (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out).toEqual({});
  });

  it("never throws on a malformed response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 }))
    );
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    const out = await fetchPolymarketContextForSymbols(["AAPL"], { AAPL: "Apple Inc." });
    expect(out).toEqual({});
  });

  it("bounds distinct symbols per run to POLYMARKET_MAX_SYMBOLS_PER_RUN", async () => {
    process.env.POLYMARKET_MAX_SYMBOLS_PER_RUN = "2";
    stubSearchEndpoint((query) => [fixtureMarket({ question: `${query} beats earnings estimates` })]);
    const { fetchPolymarketContextForSymbols } = await import("../src/lib/polymarket-provider");
    await fetchPolymarketContextForSymbols(["AAPL", "MSFT", "TSLA"], { AAPL: "Apple Inc.", MSFT: "Microsoft", TSLA: "Tesla" });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  // ── formatPolymarketLinesForPrompt (pure formatting) ────────────────────────

  it("formatPolymarketLinesForPrompt attributes Polymarket with Yes/No and a labeled tilt", async () => {
    const { formatPolymarketLinesForPrompt } = await import("../src/lib/polymarket-provider");
    const markets = [
      {
        question: "Will Apple beat earnings estimates?",
        impliedProbabilityPct: 62.4,
        outcomeLabel: "Yes",
        yesPct: 62.4,
        noPct: 37.6,
        scope: "company" as const,
        kind: "earnings_beat" as const,
        crowdLean: "yes_favored" as const,
        tilt: "bullish" as const,
        bookDepth: "ok" as const,
        volume24h: 1784.3
      },
      {
        question: "Will Apple stock hit $300 in 2026?",
        impliedProbabilityPct: 12.3,
        scope: "company" as const,
        tilt: "unclear" as const
      }
    ];
    const lines = formatPolymarketLinesForPrompt(markets);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Polymarket (company): "Will Apple beat earnings estimates?"');
    expect(lines[0]).toContain("Yes 62%");
    expect(lines[0]).toContain("No 38%");
    expect(lines[0]).toContain("tilt bullish");
    expect(lines[1]).toContain("tilt unclear — read the question");
    expect(lines.every((line) => line.startsWith("Polymarket ("))).toBe(true);
  });

  it("formatPolymarketLinesForPrompt returns [] for undefined/empty input — never a placeholder", async () => {
    const { formatPolymarketLinesForPrompt } = await import("../src/lib/polymarket-provider");
    expect(formatPolymarketLinesForPrompt(undefined)).toEqual([]);
    expect(formatPolymarketLinesForPrompt([])).toEqual([]);
  });
});

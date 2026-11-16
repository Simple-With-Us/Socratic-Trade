import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Isolated SQLite db so db-health / consent state doesn't leak across files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-breadth-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED;
  delete process.env.ROBINHOOD_ADAPTER;
  delete process.env.ENRICHMENT_CIRCUIT_BREAKER_ENABLED;
  delete process.env.FMP_API_KEY;
});

// ── Item 1: daysToEarnings (Yahoo calendarEvents) ────────────────────────────
describe("daysToEarnings (Yahoo calendarEvents)", () => {
  it("returns whole days to the earliest FUTURE earnings date", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1); // 2026-07-01
    const inTenDays = Math.floor(Date.UTC(2026, 6, 11) / 1000);
    const ce = { earnings: { earningsDate: [{ raw: inTenDays }] } };
    expect(parseDaysToEarnings(ce, now)).toBe(10);
  });

  it("ignores a past earnings date and returns undefined (never 0/guess)", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1);
    const tenDaysAgo = Math.floor(Date.UTC(2026, 5, 21) / 1000);
    const ce = { earnings: { earningsDate: [{ raw: tenDaysAgo }] } };
    expect(parseDaysToEarnings(ce, now)).toBeUndefined();
  });

  it("returns undefined when calendarEvents has no earnings date", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    expect(parseDaysToEarnings({}, Date.now())).toBeUndefined();
    expect(parseDaysToEarnings({ earnings: {} }, Date.now())).toBeUndefined();
  });

  it("picks the earliest of a lo/hi window", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1);
    const d1 = Math.floor(Date.UTC(2026, 6, 20) / 1000);
    const d2 = Math.floor(Date.UTC(2026, 6, 24) / 1000);
    const ce = { earnings: { earningsDate: [{ raw: d2 }, { raw: d1 }] } };
    expect(parseDaysToEarnings(ce, now)).toBe(19);
  });

  it("for a straddling window (low edge just past, high edge upcoming) reports the upcoming date, not undefined", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1, 12); // midday
    const lowEdge = Math.floor(Date.UTC(2026, 6, 1, 0) / 1000); // 12h ago (within the 1-day grace)
    const highEdge = Math.floor(Date.UTC(2026, 6, 4, 12) / 1000); // +3 days, upcoming
    const ce = { earnings: { earningsDate: [{ raw: lowEdge }, { raw: highEdge }] } };
    expect(parseDaysToEarnings(ce, now)).toBe(3); // earliest UPCOMING wins; the just-past low edge no longer drops it
  });

  it("reports 0 (not undefined) on earnings day when only a just-past midnight timestamp is present", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1, 15); // 3pm
    const midnightToday = Math.floor(Date.UTC(2026, 6, 1, 0) / 1000); // 15h ago, within grace
    const ce = { earnings: { earningsDate: [{ raw: midnightToday }] } };
    expect(parseDaysToEarnings(ce, now)).toBe(0);
  });
});

// ── extractUnderlyingPrice (Robinhood equity-quote parsing for option moneyness) ──
describe("extractUnderlyingPrice reads Robinhood quote shapes", () => {
  it("reads the nested `quote` envelope Robinhood commonly returns", async () => {
    const { extractUnderlyingPrice } = await import("../src/lib/robinhood");
    const nested = { results: [{ symbol: "AAPL", quote: { last_trade_price: "191.23" } }] };
    expect(extractUnderlyingPrice(nested, "AAPL")).toBe(191.23);
  });

  it("still reads a flat top-level row and skips non-matching symbols", async () => {
    const { extractUnderlyingPrice } = await import("../src/lib/robinhood");
    expect(extractUnderlyingPrice([{ symbol: "AAPL", mark_price: 188.5 }], "AAPL")).toBe(188.5);
    const multi = {
      results: [
        { symbol: "MSFT", last_trade_price: 400 },
        { symbol: "AAPL", quote: { last_trade_price: 191 } }
      ]
    };
    expect(extractUnderlyingPrice(multi, "AAPL")).toBe(191);
  });

  it("returns undefined when no positive price is present", async () => {
    const { extractUnderlyingPrice } = await import("../src/lib/robinhood");
    expect(extractUnderlyingPrice({ results: [{ symbol: "AAPL", quote: {} }] }, "AAPL")).toBeUndefined();
  });

  it("reads a top-level `{ quotes: [...] }` envelope (flat and nested-quote rows)", async () => {
    const { extractUnderlyingPrice } = await import("../src/lib/robinhood");
    // Some MCP server variants return the equity quotes under `quotes` rather than `results`.
    expect(extractUnderlyingPrice({ quotes: [{ symbol: "AAPL", last_trade_price: "190.5" }] }, "AAPL")).toBe(190.5);
    const nested = { quotes: [{ symbol: "AAPL", quote: { mark_price: 189.75 } }] };
    expect(extractUnderlyingPrice(nested, "AAPL")).toBe(189.75);
    // Symbol filtering still applies within the `quotes` envelope.
    const multi = {
      quotes: [
        { symbol: "MSFT", last_trade_price: 400 },
        { symbol: "AAPL", quote: { last_trade_price: 191 } }
      ]
    };
    expect(extractUnderlyingPrice(multi, "AAPL")).toBe(191);
  });
});

// ── Item 3: institutional ownership ──────────────────────────────────────────
describe("institution ownership (Yahoo majorHoldersBreakdown / institutionOwnership)", () => {
  it("reads majorHoldersBreakdown.institutionsPercentHeld as a 0-100 pct", async () => {
    const { parseInstitutionOwnershipPct } = await import("../src/lib/data-providers");
    expect(parseInstitutionOwnershipPct({ institutionsPercentHeld: { raw: 0.6234 } }, {})).toBe(62.34);
  });

  it("falls back to summing the institutionOwnership list", async () => {
    const { parseInstitutionOwnershipPct } = await import("../src/lib/data-providers");
    const io = { ownershipList: [{ pctHeld: { raw: 0.1 } }, { pctHeld: { raw: 0.05 } }] };
    expect(parseInstitutionOwnershipPct({}, io)).toBe(15);
  });

  it("returns undefined when neither source is present", async () => {
    const { parseInstitutionOwnershipPct } = await import("../src/lib/data-providers");
    expect(parseInstitutionOwnershipPct({}, {})).toBeUndefined();
  });
});

// ── Items 1 & 3 threaded through the Yahoo provider via a real fetch stub ─────
describe("Yahoo enrichment threads earnings + institution ownership through the cascade", () => {
  it("surfaces daysToEarnings and institutionOwnershipPct on the merged enrichment", async () => {
    const { getEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const inTwelveDays = Math.floor((Date.now() + 12 * 86_400_000) / 1000);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://fc.yahoo.com") return new Response("", { status: 200, headers: { "set-cookie": "B=t" } });
      if (url.includes("/v1/test/getcrumb")) return new Response("crumb", { status: 200, headers: { "content-type": "text/plain" } });
      if (url.includes("/v10/finance/quoteSummary/AAPL")) {
        return new Response(
          JSON.stringify({
            quoteSummary: {
              result: [
                {
                  summaryDetail: {},
                  defaultKeyStatistics: {},
                  financialData: {},
                  assetProfile: { sector: "Technology", industry: "Consumer Electronics" },
                  calendarEvents: { earnings: { earningsDate: [{ raw: inTwelveDays }] } },
                  majorHoldersBreakdown: { institutionsPercentHeld: { raw: 0.61 } }
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const provider = getEnrichmentProvider(); // yahoo-only cascade (no keys set)
    const out = await provider.enrich(["AAPL"]);
    expect(out.AAPL.daysToEarnings).toBe(12);
    expect(out.AAPL.institutionOwnershipPct).toBe(61);
    expect(out.AAPL.sources?.daysToEarnings).toBe("yahoo-finance");
    expect(out.AAPL.sources?.institutionOwnershipPct).toBe("yahoo-finance");
  });
});

// ── Item 4: Robinhood option-chain tier ──────────────────────────────────────
describe("Robinhood options enrichment tier (opt-in)", () => {
  it("stays out of the cascade by default (flag off)", async () => {
    const provider = (await import("../src/lib/data-providers")).getEnrichmentProvider();
    expect(provider.name).not.toContain("robinhood-options");
  });

  it("joins the cascade only when the flag AND Robinhood MCP are both on", async () => {
    process.env.ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED = "on";
    process.env.ROBINHOOD_ADAPTER = "mcp";
    const provider = (await import("../src/lib/data-providers")).getEnrichmentProvider("user-1");
    expect(provider.name).toContain("robinhood-options");
  });

  it("derives near-the-money IV and put/call ratio from raw chain payloads", async () => {
    const { deriveOptionMetrics } = await import("../src/lib/robinhood-options");
    const chains = {
      results: [
        { strike_price: 95, type: "call", implied_volatility: 0.30, open_interest: 100 },
        { strike_price: 100, type: "call", implied_volatility: 0.32, open_interest: 200 },
        { strike_price: 100, type: "put", implied_volatility: 0.35, open_interest: 300 },
        { strike_price: 200, type: "call", implied_volatility: 0.9, open_interest: 10 } // far OTM, excluded from p/c
      ]
    };
    const metrics = deriveOptionMetrics({ chains, instruments: undefined }, 100);
    // Closest strike to 100 with an IV → the 100-strike (0.32 → 32%).
    expect(metrics.nearTheMoneyIv).toBe(32);
    // Around-the-money OI: puts 300 / calls (100+200)=300 → 1.0; far OTM 200-strike excluded.
    expect(metrics.putCallRatio).toBe(1);
  });

  it("returns an empty object (no fabrication) when the chain has no usable rows", async () => {
    const { deriveOptionMetrics } = await import("../src/lib/robinhood-options");
    expect(deriveOptionMetrics({ chains: { results: [] }, instruments: undefined }, 100)).toEqual({});
  });

  it("falls back to volume for the put/call ratio when open interest is present but zero", async () => {
    const { deriveOptionMetrics } = await import("../src/lib/robinhood-options");
    const chains = {
      results: [
        { strike_price: 100, type: "call", implied_volatility: 0.3, open_interest: 0, volume: 200 },
        { strike_price: 100, type: "put", implied_volatility: 0.3, open_interest: 0, volume: 100 }
      ]
    };
    // OI is zero on both rows (common for new/same-day strikes) → weight by volume: puts 100 / calls 200.
    expect(deriveOptionMetrics({ chains, instruments: undefined }, 100).putCallRatio).toBe(0.5);
  });

  it("provider fails closed (empty) with no userId in scope", async () => {
    const { RobinhoodOptionsEnrichmentProvider } = await import("../src/lib/robinhood-options");
    const out = await new RobinhoodOptionsEnrichmentProvider(undefined).enrich(["AAPL"]);
    expect(out.AAPL).toEqual({});
  });

  it("without an underlying price, falls back to median IV and an unfiltered put/call ratio", async () => {
    const { deriveOptionMetrics } = await import("../src/lib/robinhood-options");
    const chains = {
      results: [
        { strike_price: 95, type: "call", implied_volatility: 0.3, open_interest: 100 },
        { strike_price: 100, type: "call", implied_volatility: 0.32, open_interest: 100 },
        { strike_price: 500, type: "put", implied_volatility: 0.8, open_interest: 100 } // far strike
      ]
    };
    const metrics = deriveOptionMetrics({ chains, instruments: undefined }); // no underlying price
    expect(metrics.nearTheMoneyIv).toBe(32); // median of [0.30, 0.32, 0.80] → 0.32 → 32%
    expect(metrics.putCallRatio).toBe(0.5); // no ATM filter → far 500 put counts: 100 / (100+100)
  });

  it("caches option data per-user: user B never receives user A's Robinhood-derived metrics", async () => {
    vi.resetModules();
    // Only user A has a connected Robinhood session; user B's own fetch fails closed (null).
    vi.doMock("../src/lib/robinhood", () => ({
      fetchRobinhoodOptionChain: async (_sym: string, userId: string) =>
        userId === "userA"
          ? {
              chains: {
                results: [
                  { strike_price: 100, type: "call", implied_volatility: 0.32, open_interest: 200 },
                  { strike_price: 100, type: "put", implied_volatility: 0.35, open_interest: 200 }
                ]
              },
              instruments: undefined,
              underlyingPrice: 100
            }
          : null
    }));
    try {
      const { RobinhoodOptionsEnrichmentProvider, clearRobinhoodOptionsCache } = await import(
        "../src/lib/robinhood-options"
      );
      clearRobinhoodOptionsCache();
      const a = await new RobinhoodOptionsEnrichmentProvider("userA").enrich(["AAPL"]);
      expect(a.AAPL.nearTheMoneyIv).toBe(32); // user A warms the (user-keyed) cache

      const b = await new RobinhoodOptionsEnrichmentProvider("userB").enrich(["AAPL"]);
      expect(b.AAPL).toEqual({}); // user B must NOT be served user A's cached, token-derived data
    } finally {
      vi.doUnmock("../src/lib/robinhood");
      vi.resetModules();
    }
  });
});

// ── Item 5: active circuit breaker ───────────────────────────────────────────
describe("enrichment circuit breaker (opt-in)", () => {
  it("skips a lane whose db-health is stoppedWorking, but retries after backoff", async () => {
    const mod = await import("../src/lib/data-providers");
    const { applyCircuitBreaker } = mod;
    const { logApiHealth } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log WHERE service = ?").run("finnhub");

    // 5 consecutive failures → stoppedWorking for the finnhub lane.
    for (let i = 0; i < 5; i++) logApiHealth({ service: "finnhub", ok: false, errorText: "HTTP 500" });

    const finnhubLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "finnhub",
      configured: true,
      async enrich(symbols) {
        const out: Record<string, import("../src/lib/data-providers").SymbolEnrichment> = {};
        for (const s of symbols) out[s] = { peRatio: 10 };
        return out;
      }
    };
    const yahooLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "yahoo-finance",
      configured: true,
      async enrich() {
        return {};
      }
    };

    // Long backoff → the tripped lane is skipped this scan (last failure is fresh).
    process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN = "60";
    const tripped = applyCircuitBreaker([finnhubLike, yahooLike]);
    const finnhubOut = await tripped[0].enrich(["AAPL"]);
    expect(finnhubOut.AAPL).toEqual({}); // no-op'd — did NOT return peRatio
    expect(tripped[0].name).toBe("finnhub"); // lane name preserved

    // Age every finnhub failure row well past the backoff window → the lane may re-probe.
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    getDb().prepare("UPDATE api_health_log SET ts = ? WHERE service = ?").run(oldTs, "finnhub");
    const reprobe = applyCircuitBreaker([finnhubLike, yahooLike]);
    const reprobeOut = await reprobe[0].enrich(["AAPL"]);
    expect(reprobeOut.AAPL).toEqual({ peRatio: 10 });
    delete process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN;
  });

  it("leaves a healthy lane untouched", async () => {
    const { applyCircuitBreaker } = await import("../src/lib/data-providers");
    const { logApiHealth } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log WHERE service = ?").run("fmp");
    logApiHealth({ service: "fmp", ok: true, latencyMs: 20 });

    const fmpLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "fmp",
      configured: true,
      async enrich(symbols) {
        const out: Record<string, import("../src/lib/data-providers").SymbolEnrichment> = {};
        for (const s of symbols) out[s] = { peRatio: 22 };
        return out;
      }
    };
    const [wrapped] = applyCircuitBreaker([fmpLike]);
    expect(await wrapped.enrich(["AAPL"])).toEqual({ AAPL: { peRatio: 22 } });
  });

  it("does NOT trip on a single cold failure (only a 5-consecutive-failure streak trips)", async () => {
    const { applyCircuitBreaker } = await import("../src/lib/data-providers");
    const { logApiHealth } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log WHERE service = ?").run("finnhub");
    // One failure, no success ever → db-health sets stoppedWorking with the SOFT "no success yet this
    // hour" reason. A newly-configured provider must not be blacked out for the whole backoff on that.
    logApiHealth({ service: "finnhub", ok: false, errorText: "HTTP 500" });

    const finnhubLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "finnhub",
      configured: true,
      async enrich(symbols) {
        const out: Record<string, import("../src/lib/data-providers").SymbolEnrichment> = {};
        for (const s of symbols) out[s] = { peRatio: 10 };
        return out;
      }
    };
    const [wrapped] = applyCircuitBreaker([finnhubLike]);
    expect(await wrapped.enrich(["AAPL"])).toEqual({ AAPL: { peRatio: 10 } }); // NOT skipped
  });

  it("scopes the trip to the provider's own credential lane (dead env lane spares a healthy user lane)", async () => {
    const { applyCircuitBreaker } = await import("../src/lib/data-providers");
    const { logApiHealth } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log WHERE service = ?").run("finnhub");
    // Two credential lanes for the SAME service: the env-key lane is hard-stopped (5 consecutive
    // failures), the user-key lane is healthy. Only the provider running on the dead lane should trip.
    for (let i = 0; i < 5; i++) logApiHealth({ service: "finnhub", ok: false, errorText: "HTTP 500", keySource: "env" });
    logApiHealth({ service: "finnhub", ok: true, latencyMs: 20, keySource: "user" });

    const makeFinnhub = (source: "env" | "user"): import("../src/lib/data-providers").MarketEnrichmentProvider => ({
      name: "finnhub",
      configured: true,
      healthKeySource: source,
      async enrich(symbols) {
        const out: Record<string, import("../src/lib/data-providers").SymbolEnrichment> = {};
        for (const s of symbols) out[s] = { peRatio: 10 };
        return out;
      }
    });

    process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN = "60";
    // env-lane provider: its own lane is hard-stopped → tripped (no-op'd).
    const [envWrapped] = applyCircuitBreaker([makeFinnhub("env")]);
    expect(await envWrapped.enrich(["AAPL"])).toEqual({ AAPL: {} });
    // user-lane provider: its own lane is healthy → NOT tripped even though the env lane is dead.
    const [userWrapped] = applyCircuitBreaker([makeFinnhub("user")]);
    expect(await userWrapped.enrich(["AAPL"])).toEqual({ AAPL: { peRatio: 10 } });
    delete process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN;
  });
});

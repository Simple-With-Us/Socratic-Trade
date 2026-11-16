// Tests for the token-gated market-data READ endpoints (congress.trade cache-aside price pulls):
//   GET /api/market/prices/{symbol}  -> PriceSeries envelope, closes DESCENDING
//   GET /api/market/spx              -> { closes } DESCENDING (SPY daily bars)
//   GET /api/market/quotes + /api/market/intraday/{symbol} (#2953 peer routes)
// plus the src/lib/market-read.ts shaping helpers and the middleware bearer pass-through.
//
// Route tests drive the real handlers with APP_B_INGEST_TOKEN set; fetchDailyOHLC is module-mocked
// so no network/DB is touched. Lib tests inject canned bars via the fetcher parameter instead.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { OHLCBar } from "../src/lib/indicators";
import { latestCompletedTradingSessionEtKey } from "../src/lib/market-hours";
import { clearScreenerProfileCacheForTests, closesInRange, fetchCompanyProfile, fetchPriceSeries, fetchSpxCloses, parseMarketRange } from "../src/lib/market-read";
import { GET as profileRoute } from "../app/api/market/profile/[symbol]/route";
import { fetchDailyOHLC } from "../src/lib/history";
import { GET as pricesRoute } from "../app/api/market/prices/[symbol]/route";
import { GET as spxRoute } from "../app/api/market/spx/route";

vi.mock("../src/lib/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});
const mockFetchDailyOHLC = vi.mocked(fetchDailyOHLC);

const TEST_TOKEN = "st_ingest_test_secret";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-market-read-${randomUUID()}.db`)}`;
  for (const key of ["APP_B_INGEST_TOKEN", "AUTH_SECRET"]) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  process.env.APP_B_INGEST_TOKEN = TEST_TOKEN;
  mockFetchDailyOHLC.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearScreenerProfileCacheForTests();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Canned daily bar with a ms-epoch time (Massive shape). */
function bar(date: string, close: number, volume?: number): OHLCBar {
  return { time: Date.parse(`${date}T00:00:00Z`), close, ...(volume !== undefined ? { volume } : {}) };
}

/** 2026-07-30 21:00 UTC is after the 16:00 ET close, so that session is the latest completed one. */
const JULY_30_AFTER_CLOSE = Date.UTC(2026, 6, 30, 21, 0, 0);

function priorIsoDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function isoDaysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function authedRequest(url: string, token?: string): Request {
  // No default: an omitted token must produce a genuinely header-less request (the 401 path).
  return new Request(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

// ── parseMarketRange ─────────────────────────────────────────────────────────

describe("parseMarketRange", () => {
  const now = new Date(Date.UTC(2026, 6, 31)); // 2026-07-31

  it("defaults to a ~1y window ending today when params are omitted", () => {
    expect(parseMarketRange("http://x/api/market/spx", now)).toEqual({ from: "2025-07-30", to: "2026-07-31" });
  });

  it("passes valid from/to through unchanged", () => {
    expect(parseMarketRange("http://x/api/market/spx?from=2026-01-01&to=2026-06-30", now)).toEqual({
      from: "2026-01-01",
      to: "2026-06-30"
    });
  });

  it("falls back to the default for malformed params instead of erroring", () => {
    expect(parseMarketRange("http://x/api/market/spx?from=yesterday&to=2026-06-30", now)).toEqual({
      from: "2025-07-30",
      to: "2026-06-30"
    });
  });
});

// ── closesInRange ────────────────────────────────────────────────────────────

describe("closesInRange", () => {
  it("filters inclusively and preserves order", () => {
    const closes = [
      { date: "2026-07-28", close: 1 },
      { date: "2026-07-29", close: 2 },
      { date: "2026-07-30", close: 3 },
      { date: "2026-07-31", close: 4 }
    ];
    expect(closesInRange(closes, "2026-07-29", "2026-07-30")).toEqual([
      { date: "2026-07-29", close: 2 },
      { date: "2026-07-30", close: 3 }
    ]);
  });
});

// ── fetchPriceSeries ─────────────────────────────────────────────────────────

describe("fetchPriceSeries", () => {
  const range = { from: "2026-07-01", to: "2026-07-31" };

  it("returns closes DESCENDING with volume, ticker uppercased", async () => {
    const read = await fetchPriceSeries("aapl", range, async () => [
      bar("2026-07-28", 230.1, 40_000_000),
      bar("2026-07-29", 231.0, 41_000_000),
      bar("2026-07-30", 233.4, 41_230_000)
    ], JULY_30_AFTER_CLOSE);
    expect(read).toEqual({
      kind: "ok",
      series: {
        ticker: "AAPL",
        closes: [
          { date: "2026-07-30", close: 233.4, volume: 41_230_000 },
          { date: "2026-07-29", close: 231.0, volume: 41_000_000 },
          { date: "2026-07-28", close: 230.1, volume: 40_000_000 }
        ],
        currentPrice: 233.4,
        currentPriceDate: "2026-07-30"
      }
    });
  });

  it("filters closes to [from, to] but keeps currentPrice from the full series", async () => {
    const read = await fetchPriceSeries("AAPL", { from: "2026-07-01", to: "2026-07-28" }, async () => [
      bar("2026-07-27", 228),
      bar("2026-07-28", 230.1),
      bar("2026-07-30", 233.4)
    ], JULY_30_AFTER_CLOSE);
    expect(read).toEqual({
      kind: "ok",
      series: {
        ticker: "AAPL",
        closes: [
          { date: "2026-07-28", close: 230.1 },
          { date: "2026-07-27", close: 228 }
        ],
        currentPrice: 233.4,
        currentPriceDate: "2026-07-30"
      }
    });
  });

  it("unknown symbol / no bars → ok empty series (closes: [], null currentPrice)", async () => {
    const read = await fetchPriceSeries("NOTREAL", range, async () => null);
    expect(read).toEqual({
      kind: "ok",
      series: { ticker: "NOTREAL", closes: [], currentPrice: null, currentPriceDate: null }
    });
  });

  it("empty symbol never calls the fetcher", async () => {
    const fetcher = vi.fn(async () => [bar("2026-07-30", 1)]);
    const read = await fetchPriceSeries("   ", range, fetcher, JULY_30_AFTER_CLOSE);
    expect(fetcher).not.toHaveBeenCalled();
    expect(read).toEqual({
      kind: "ok",
      series: { ticker: "", closes: [], currentPrice: null, currentPriceDate: null }
    });
  });

  it("marks a stale tail so the route can return 502 instead of an empty 200", async () => {
    // Now is 2026-07-31 after the close, so the newest close (2026-07-30) is one
    // session behind the latest completed session — a short lag within the
    // terminal-series threshold, so it stays stale rather than terminal.
    const read = await fetchPriceSeries("AAPL", range, async () => [
      bar("2026-07-29", 231),
      bar("2026-07-30", 233.4)
    ], Date.UTC(2026, 6, 31, 21, 0, 0));
    expect(read).toEqual({ kind: "stale" });
  });

  it("returns ok for a terminal (delisted) series ending ~1 year ago", async () => {
    // Control: at the same clock a one-session lag is still withheld, so the
    // stale gate is live and the ok below comes from the terminal exemption.
    const control = await fetchPriceSeries("AAPL", range, async () => [
      bar("2026-07-28", 231),
      bar("2026-07-29", 233.4)
    ], JULY_30_AFTER_CLOSE);
    expect(control).toEqual({ kind: "stale" });
    const read = await fetchPriceSeries("PXD", { from: "2025-07-01", to: "2026-07-31" }, async () => [
      bar("2025-07-29", 250),
      bar("2025-07-30", 251.5)
    ], JULY_30_AFTER_CLOSE);
    expect(read).toEqual({
      kind: "ok",
      series: {
        ticker: "PXD",
        closes: [
          { date: "2025-07-30", close: 251.5 },
          { date: "2025-07-29", close: 250 }
        ],
        currentPrice: 251.5,
        currentPriceDate: "2025-07-30"
      }
    });
  });
});

// ── fetchSpxCloses ───────────────────────────────────────────────────────────

describe("fetchSpxCloses", () => {
  it("pulls SPY bars and returns them DESCENDING within the range", async () => {
    const fetcher = vi.fn(async () => [bar("2026-07-29", 635.1), bar("2026-07-30", 636.2)]);
    const read = await fetchSpxCloses({ from: "2026-07-01", to: "2026-07-31" }, fetcher, JULY_30_AFTER_CLOSE);
    expect(fetcher).toHaveBeenCalledWith("SPY");
    expect(read).toEqual({
      kind: "ok",
      closes: [
        { date: "2026-07-30", close: 636.2 },
        { date: "2026-07-29", close: 635.1 }
      ]
    });
  });

  it("returns an empty array when no SPY bars are available", async () => {
    expect(await fetchSpxCloses({ from: "2026-07-01", to: "2026-07-31" }, async () => null)).toEqual({
      kind: "ok",
      closes: []
    });
  });

  it("marks SPY bars that end before the latest completed session as stale", async () => {
    const read = await fetchSpxCloses(
      { from: "2026-07-01", to: "2026-07-31" },
      async () => [bar("2026-07-29", 635.1), bar("2026-07-30", 636.2)],
      Date.UTC(2026, 9, 15, 14, 0, 0)
    );
    expect(read).toEqual({ kind: "stale" });
  });
});

// ── route handlers ───────────────────────────────────────────────────────────

describe("GET /api/market/prices/[symbol]", () => {
  const url = "http://localhost/api/market/prices/AAPL?from=2026-07-01&to=2026-07-31";
  const ctx = { params: Promise.resolve({ symbol: "AAPL" }) };

  it("401s without a bearer token (and never fetches)", async () => {
    const res = await pricesRoute(authedRequest(url), ctx);
    expect(res.status).toBe(401);
    expect(mockFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("401s with a wrong bearer token", async () => {
    const res = await pricesRoute(authedRequest(url, "st_ingest_wrong"), ctx);
    expect(res.status).toBe(401);
    expect(mockFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("401s when APP_B_INGEST_TOKEN is not configured (default-closed)", async () => {
    delete process.env.APP_B_INGEST_TOKEN;
    const res = await pricesRoute(authedRequest(url, TEST_TOKEN), ctx);
    expect(res.status).toBe(401);
  });

  it("200 with the contract envelope (closes DESCENDING) for an authorized read", async () => {
    const latest = latestCompletedTradingSessionEtKey(Date.now());
    const prior = priorIsoDay(latest);
    mockFetchDailyOHLC.mockResolvedValue([
      bar(prior, 231.0, 41_000_000),
      bar(latest, 233.4, 41_230_000)
    ]);
    const res = await pricesRoute(
      authedRequest(`http://localhost/api/market/prices/AAPL?from=${prior}&to=${latest}`, TEST_TOKEN),
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticker: "AAPL",
      closes: [
        { date: latest, close: 233.4, volume: 41_230_000 },
        { date: prior, close: 231.0, volume: 41_000_000 }
      ],
      currentPrice: 233.4,
      currentPriceDate: latest
    });
  });

  it("502 when the newest close is behind the latest session", async () => {
    // One session behind the latest completed session — a short lag within the
    // terminal-series threshold, so it still 502s for provider fallback.
    const latest = latestCompletedTradingSessionEtKey(Date.now());
    const newest = priorIsoDay(latest);
    const prior = priorIsoDay(newest);
    mockFetchDailyOHLC.mockResolvedValue([bar(prior, 10), bar(newest, 11)]);
    const res = await pricesRoute(
      authedRequest(`http://localhost/api/market/prices/AAPL?from=${prior}&to=${latest}`, TEST_TOKEN),
      ctx
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "stale" });
  });

  it("200 for a terminal (delisted) series ending ~1 year ago", async () => {
    const latest = latestCompletedTradingSessionEtKey(Date.now());
    const last = isoDaysBefore(latest, 365);
    const prior = isoDaysBefore(latest, 366);
    // Control: a one-session lag at the same clock still 502s, so the stale gate
    // is live and the 200 below comes from the terminal exemption.
    const lagNewest = priorIsoDay(latest);
    mockFetchDailyOHLC.mockResolvedValueOnce([bar(priorIsoDay(lagNewest), 10), bar(lagNewest, 11)]);
    const controlRes = await pricesRoute(
      authedRequest(`http://localhost/api/market/prices/AAPL?from=${prior}&to=${latest}`, TEST_TOKEN),
      ctx
    );
    expect(controlRes.status).toBe(502);
    mockFetchDailyOHLC.mockResolvedValue([bar(prior, 10), bar(last, 11)]);
    const res = await pricesRoute(
      authedRequest(`http://localhost/api/market/prices/PXD?from=${prior}&to=${latest}`, TEST_TOKEN),
      { params: Promise.resolve({ symbol: "PXD" }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticker: "PXD",
      closes: [
        { date: last, close: 11 },
        { date: prior, close: 10 }
      ],
      currentPrice: 11,
      currentPriceDate: last
    });
  });

  it("503 only for coded sqlite busy, not message-only provider lock text", async () => {
    const codedBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_SNAPSHOT" });
    mockFetchDailyOHLC.mockRejectedValue(codedBusy);
    const busyRes = await pricesRoute(authedRequest(url, TEST_TOKEN), ctx);
    expect(busyRes.status).toBe(503);
    expect(busyRes.headers.get("retry-after")).toBe("2");
    expect(await busyRes.json()).toEqual({ ok: false, error: "database temporarily unavailable" });

    mockFetchDailyOHLC.mockRejectedValue(new Error("provider said database is locked"));
    await expect(pricesRoute(authedRequest(url, TEST_TOKEN), ctx)).rejects.toThrow(
      "provider said database is locked"
    );
  });

  it("200 with empty closes for an unknown symbol (not an error status)", async () => {
    mockFetchDailyOHLC.mockResolvedValue(null);
    const res = await pricesRoute(authedRequest("http://localhost/api/market/prices/NOTREAL", TEST_TOKEN), {
      params: Promise.resolve({ symbol: "NOTREAL" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe("NOTREAL");
    expect(body.closes).toEqual([]);
  });
});

describe("GET /api/market/spx", () => {
  const url = "http://localhost/api/market/spx?from=2026-07-01&to=2026-07-31";

  it("401s without a bearer token", async () => {
    const res = await spxRoute(authedRequest(url));
    expect(res.status).toBe(401);
    expect(mockFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("200 with { closes } DESCENDING from SPY daily bars", async () => {
    const latest = latestCompletedTradingSessionEtKey(Date.now());
    const prior = priorIsoDay(latest);
    mockFetchDailyOHLC.mockResolvedValue([bar(prior, 635.1), bar(latest, 636.2)]);
    const res = await spxRoute(authedRequest(`http://localhost/api/market/spx?from=${prior}&to=${latest}`, TEST_TOKEN));
    expect(res.status).toBe(200);
    // The peer-serving default must skip the App A read-back tier: serving App A's own
    // request through a tier that calls App A back is a guaranteed-wasted echo hop.
    expect(mockFetchDailyOHLC).toHaveBeenCalledWith("SPY", expect.any(Number), undefined, {
      skipAppATier: true,
      usageLabel: "congress-read",
    });
    expect(await res.json()).toEqual({
      closes: [
        { date: latest, close: 636.2 },
        { date: prior, close: 635.1 }
      ]
    });
  });

  it("502 when SPY ends before the latest session", async () => {
    mockFetchDailyOHLC.mockResolvedValue([bar("2020-01-02", 1), bar("2020-01-03", 2)]);
    const res = await spxRoute(authedRequest(url, TEST_TOKEN));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "stale" });
  });

  it("200 with { closes: [] } when no SPY bars exist in range", async () => {
    mockFetchDailyOHLC.mockResolvedValue(null);
    const res = await spxRoute(authedRequest(url, TEST_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closes: [] });
  });
});


// ── /api/market/profile/{symbol} ─────────────────────────────────────────────

describe("GET /api/market/profile/{symbol}", () => {
  function profileUrl(symbol: string): string {
    return `http://x/api/market/profile/${symbol}`;
  }

  it("401 without bearer", async () => {
    const res = await profileRoute(authedRequest(profileUrl("AAPL")), {
      params: Promise.resolve({ symbol: "AAPL" })
    });
    expect(res.status).toBe(401);
  });

  it("404 { ref: null } envelope when screener has no row (no bare framework 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { table: { rows: [] } } })
      ) as unknown as typeof fetch
    );
    const res = await profileRoute(authedRequest(profileUrl("ZZZZNOPE"), TEST_TOKEN), {
      params: Promise.resolve({ symbol: "ZZZZNOPE" })
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ref: null });
  });

  it("helper returns null when the injected lookup misses", async () => {
    expect(await fetchCompanyProfile("ZZZZNOPE", async () => null)).toBeNull();
  });

  it("200 { ref } when lookup returns sector/industry/marketCap", async () => {
    // Unit the helper with an injected lookup (no network / DB).
    const ref = await fetchCompanyProfile("MSFT", async () => ({
      ticker: "MSFT",
      companyName: "Microsoft Corporation",
      sector: "Technology",
      industry: "Software",
      marketCap: 3_000_000_000_000,
      assetClass: "equity"
    }));
    expect(ref).toEqual({
      ticker: "MSFT",
      companyName: "Microsoft Corporation",
      sector: "Technology",
      industry: "Software",
      marketCap: 3_000_000_000_000,
      assetClass: "equity"
    });
  });

  it("does not cache empty map after Nasdaq screener fetch failure — subsequent call retries", async () => {
    clearScreenerProfileCacheForTests();
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          throw new Error("nasdaq transient failure");
        }
        return Response.json({
          data: {
            table: {
              rows: [
                {
                  symbol: "RETRYTICK",
                  name: "Retry Co",
                  sector: "Technology",
                  industry: "Software",
                  marketCap: "1000000000"
                }
              ]
            }
          }
        });
      }) as unknown as typeof fetch
    );

    expect(await fetchCompanyProfile("RETRYTICK")).toBeNull();
    const callsAfterFailure = fetchCalls;
    expect(callsAfterFailure).toBeGreaterThanOrEqual(1);

    const ref = await fetchCompanyProfile("RETRYTICK");
    expect(ref).toMatchObject({
      ticker: "RETRYTICK",
      companyName: "Retry Co",
      sector: "Technology",
      industry: "Software",
      marketCap: 1_000_000_000,
      assetClass: "equity"
    });
    expect(fetchCalls).toBeGreaterThan(callsAfterFailure);

    // Successful map is cached — a third lookup must not re-hit Nasdaq.
    const callsAfterSuccess = fetchCalls;
    expect(await fetchCompanyProfile("RETRYTICK")).toMatchObject({ ticker: "RETRYTICK" });
    expect(fetchCalls).toBe(callsAfterSuccess);
  });

  it("does not cache empty map after non-OK Nasdaq screener response — subsequent call retries", async () => {
    clearScreenerProfileCacheForTests();
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response("upstream unavailable", { status: 503 });
        }
        return Response.json({
          data: {
            table: {
              rows: [
                {
                  symbol: "RETRY503",
                  name: "Retry Five Oh Three",
                  sector: "Healthcare",
                  industry: "Biotech",
                  marketCap: "500000000"
                }
              ]
            }
          }
        });
      }) as unknown as typeof fetch
    );

    expect(await fetchCompanyProfile("RETRY503")).toBeNull();
    const callsAfterFailure = fetchCalls;
    expect(callsAfterFailure).toBeGreaterThanOrEqual(1);

    const ref = await fetchCompanyProfile("RETRY503");
    expect(ref).toMatchObject({
      ticker: "RETRY503",
      companyName: "Retry Five Oh Three",
      sector: "Healthcare"
    });
    expect(fetchCalls).toBeGreaterThan(callsAfterFailure);
  });

  // Past SCREENER_PROFILE_TTL_MS (5 min) so the next lookup must refresh, and
  // past SCREENER_PROFILE_STALE_RETRY_MS (30s) so the refresh is allowed again.
  const PROFILE_TTL_PAST_MS = 5 * 60_000 + 1_000;
  const STALE_RETRY_PAST_MS = 60_000;

  function screenerProfileResponse(symbol: string, name: string): Response {
    return Response.json({
      data: {
        table: {
          rows: [
            {
              symbol,
              name,
              sector: "Technology",
              industry: "Software",
              marketCap: "1000000000"
            }
          ]
        }
      }
    });
  }

  async function withProfileClock(run: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    let now = start;
    try {
      await run((ms) => {
        now += ms;
        vi.setSystemTime(now);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  async function seedThenBlip(
    symbol: string,
    fail: () => Response | Promise<Response>
  ): Promise<void> {
    clearScreenerProfileCacheForTests();
    const previousRateLimit = process.env.PROVIDER_RATE_LIMIT_DISABLED;
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    let phase: "ok" | "fail" | "recovered" = "ok";
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        if (phase === "fail") return fail();
        const name = phase === "recovered" ? "Recovered Co" : "Stale Co";
        return screenerProfileResponse(symbol, name);
      }) as unknown as typeof fetch
    );
    try {
      await withProfileClock(async (advance) => {
        expect(await fetchCompanyProfile(symbol)).toMatchObject({
          ticker: symbol,
          companyName: "Stale Co",
          sector: "Technology",
          industry: "Software",
          marketCap: 1_000_000_000,
          assetClass: "equity"
        });

        advance(PROFILE_TTL_PAST_MS);
        phase = "fail";
        expect(await fetchCompanyProfile(symbol)).toMatchObject({
          ticker: symbol,
          companyName: "Stale Co"
        });
        expect(await fetchCompanyProfile("ZZZZNOPE")).toBeNull();

        const callsAfterFail = fetchCalls;
        expect(await fetchCompanyProfile(symbol)).toMatchObject({
          ticker: symbol,
          companyName: "Stale Co"
        });
        expect(fetchCalls).toBe(callsAfterFail);

        advance(STALE_RETRY_PAST_MS);
        phase = "recovered";
        expect(await fetchCompanyProfile(symbol)).toMatchObject({
          ticker: symbol,
          companyName: "Recovered Co"
        });
        expect(fetchCalls).toBeGreaterThan(callsAfterFail);
      });
    } finally {
      if (previousRateLimit === undefined) delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
      else process.env.PROVIDER_RATE_LIMIT_DISABLED = previousRateLimit;
    }
  }

  it("serves the last successful screener map when a later fetch throws", async () => {
    await seedThenBlip("STALETHROW", async () => {
      throw new Error("Nasdaq delayed screener timed out waiting for api.nasdaq.com.");
    });
  });

  it("serves the last successful screener map when a later screener response is non-OK", async () => {
    await seedThenBlip("STALE503", async () => new Response("upstream unavailable", { status: 503 }));
  });

  it("returns 200 { ref } for a known ticker when the screener times out after a good map", async () => {
    clearScreenerProfileCacheForTests();
    const previousRateLimit = process.env.PROVIDER_RATE_LIMIT_DISABLED;
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    let fail = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fail) throw new Error("Nasdaq delayed screener timed out waiting for api.nasdaq.com.");
        return screenerProfileResponse("STALEROUTE", "Route Co");
      }) as unknown as typeof fetch
    );
    try {
      await withProfileClock(async (advance) => {
        expect(await fetchCompanyProfile("STALEROUTE")).toMatchObject({ ticker: "STALEROUTE" });
        advance(PROFILE_TTL_PAST_MS);
        fail = true;
        const res = await profileRoute(authedRequest(profileUrl("STALEROUTE"), TEST_TOKEN), {
          params: Promise.resolve({ symbol: "STALEROUTE" })
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ref: { ticker?: string; companyName?: string } };
        expect(body.ref).toMatchObject({
          ticker: "STALEROUTE",
          companyName: "Route Co",
          assetClass: "equity"
        });
      });
    } finally {
      if (previousRateLimit === undefined) delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
      else process.env.PROVIDER_RATE_LIMIT_DISABLED = previousRateLimit;
    }
  });

  it("keeps the 30s hold after a timeout that lasts as long as the hold", async () => {
    clearScreenerProfileCacheForTests();
    const previousRateLimit = process.env.PROVIDER_RATE_LIMIT_DISABLED;
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = start;
    vi.setSystemTime(now);
    let phase: "ok" | "fail" | "recovered" = "ok";
    let burnedTimeout = false;
    let fetchCalls = 0;
    const advance = (ms: number) => {
      now += ms;
      vi.setSystemTime(now);
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        if (phase === "fail") {
          // Two 15s screener attempts. The hold must start when they finish.
          if (!burnedTimeout) {
            burnedTimeout = true;
            advance(30_000);
          }
          throw new Error("Nasdaq delayed screener timed out waiting for api.nasdaq.com.");
        }
        const name = phase === "recovered" ? "Recovered Co" : "Slow Co";
        return screenerProfileResponse("SLOWTICK", name);
      }) as unknown as typeof fetch
    );
    try {
      expect(await fetchCompanyProfile("SLOWTICK")).toMatchObject({
        ticker: "SLOWTICK",
        companyName: "Slow Co"
      });
      advance(PROFILE_TTL_PAST_MS);
      phase = "fail";
      expect(await fetchCompanyProfile("SLOWTICK")).toMatchObject({
        ticker: "SLOWTICK",
        companyName: "Slow Co"
      });
      const callsAfterFail = fetchCalls;
      expect(await fetchCompanyProfile("SLOWTICK")).toMatchObject({ companyName: "Slow Co" });
      expect(fetchCalls).toBe(callsAfterFail);
      advance(29_000);
      expect(await fetchCompanyProfile("SLOWTICK")).toMatchObject({ companyName: "Slow Co" });
      expect(fetchCalls).toBe(callsAfterFail);
      advance(1_000);
      phase = "recovered";
      expect(await fetchCompanyProfile("SLOWTICK")).toMatchObject({ companyName: "Recovered Co" });
      expect(fetchCalls).toBeGreaterThan(callsAfterFail);
    } finally {
      vi.useRealTimers();
      if (previousRateLimit === undefined) delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
      else process.env.PROVIDER_RATE_LIMIT_DISABLED = previousRateLimit;
    }
  });

  it("serves the last-good map before a slow live refresh finishes", async () => {
    clearScreenerProfileCacheForTests();
    const previousRateLimit = process.env.PROVIDER_RATE_LIMIT_DISABLED;
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    let hangReject: (err: unknown) => void = () => {};
    const hang = new Promise<Response>((_resolve, reject) => {
      hangReject = reject;
    });
    let phase: "ok" | "hang" = "ok";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (phase === "hang") return hang;
        return screenerProfileResponse("PROMPTSTALE", "Prompt Co");
      }) as unknown as typeof fetch
    );
    try {
      await withProfileClock(async (advance) => {
        expect(await fetchCompanyProfile("PROMPTSTALE")).toMatchObject({
          ticker: "PROMPTSTALE",
          companyName: "Prompt Co"
        });
        advance(PROFILE_TTL_PAST_MS);
        phase = "hang";
        const pending = fetchCompanyProfile("PROMPTSTALE");
        const STALE_SERVE_BUDGET_MS = 1_000;
        const raced = await Promise.race([
          pending.then((ref) => ({ kind: "done" as const, ref })),
          new Promise<{ kind: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" }), STALE_SERVE_BUDGET_MS + 1_500)
          )
        ]);
        expect(raced.kind).toBe("done");
        if (raced.kind === "done") {
          expect(raced.ref).toMatchObject({
            ticker: "PROMPTSTALE",
            companyName: "Prompt Co"
          });
        }
      });
    } finally {
      hangReject(new Error("test cleanup: release hung screener fetch"));
      if (previousRateLimit === undefined) delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
      else process.env.PROVIDER_RATE_LIMIT_DISABLED = previousRateLimit;
    }
  });

  it("does not serve a last-good map older than 24 hours", async () => {
    clearScreenerProfileCacheForTests();
    const previousRateLimit = process.env.PROVIDER_RATE_LIMIT_DISABLED;
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    let phase: "ok" | "fail" = "ok";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (phase === "fail") {
          throw new Error("Nasdaq delayed screener timed out waiting for api.nasdaq.com.");
        }
        return screenerProfileResponse("OLDSTALE", "Old Co");
      }) as unknown as typeof fetch
    );
    try {
      await withProfileClock(async (advance) => {
        expect(await fetchCompanyProfile("OLDSTALE")).toMatchObject({
          ticker: "OLDSTALE",
          companyName: "Old Co"
        });
        advance(24 * 60 * 60_000 + 1);
        phase = "fail";
        expect(await fetchCompanyProfile("OLDSTALE")).toBeNull();
        const res = await profileRoute(authedRequest(profileUrl("OLDSTALE"), TEST_TOKEN), {
          params: Promise.resolve({ symbol: "OLDSTALE" })
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ ref: null });
      });
    } finally {
      if (previousRateLimit === undefined) delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
      else process.env.PROVIDER_RATE_LIMIT_DISABLED = previousRateLimit;
    }
  });

  it("returns null from the helper for an empty symbol", async () => {
    expect(await fetchCompanyProfile("   ", async () => ({ ticker: "X" }))).toBeNull();
  });
});

// ── middleware pass-through ──────────────────────────────────────────────────

describe("middleware — market read bearer pass-through", () => {
  async function loadMiddleware() {
    const mod = await import("../middleware.js");
    return mod.middleware as (req: NextRequest) => Promise<import("next/server").NextResponse>;
  }

  function mwRequest(path: string, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`https://trading.example.com${path}`, { headers });
  }

  it("lets a bearer request through to /api/market/spx without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/spx", { authorization: `Bearer ${TEST_TOKEN}` }));
    // Passed through (NextResponse.next) — NOT the fail-closed 401.
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/prices/{symbol} without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/prices/AAPL", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/quotes without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/quotes", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/intraday/{symbol} without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/intraday/AAPL", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/profile/{symbol} without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/profile/AAPL", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("still fail-closes /api/market/quotes with NO bearer token", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/quotes"));
    expect(res.status).toBe(401);
  });

  it("still fail-closes /api/market/spx with NO bearer token", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/spx"));
    expect(res.status).toBe(401);
  });

  it("does NOT extend the bypass to /api/market/flatfile (stays session-gated)", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/flatfile?date=2026-07-30", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).toBe(401);
  });
});

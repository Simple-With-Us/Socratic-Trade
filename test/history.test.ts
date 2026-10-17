import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { clearHistoryCache, fetchDailyOHLC, parseRoicStockPrices, parseStooqCsv, toBusinessDay } from "../src/lib/history";
import { upsertHistoryCacheEod } from "../src/lib/history-cache";
import { latestCompletedTradingSessionEtKey } from "../src/lib/market-hours";
import { clearMassiveRestBudgetForTests } from "../src/lib/market-signals/massive";
import { clearMarketDataDemandsForTests, deleteInternalSetting, deleteUserApiKey, getDb, setDataPoolConsent, upsertConnectedAccount, upsertUserApiKey } from "../src/lib/db";
import { subscribeDashboardEvents, type DashboardEvent } from "../src/lib/events";
import { admitProviderRequests, resetProviderQuotaState } from "../src/lib/provider-rate-limit";
import { apiKeyFingerprint } from "../src/lib/data-providers";

const historyTestDb = `file:${join(tmpdir(), `agentic-history-cache-test-${randomUUID()}.db`)}`;

beforeEach(() => {
  process.env.DATABASE_URL = historyTestDb;
  clearHistoryCache();
  try { getDb().exec("DELETE FROM imported_price_eod"); } catch {}
  clearMarketDataDemandsForTests();
  clearMassiveRestBudgetForTests();
  // Keep the cascade on the (mocked) free sources — keyed providers are skipped without keys.
  delete process.env.MASSIVE_API_KEY;
  delete process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE;
  delete process.env.MASSIVE_HISTORY_ENABLED;
  delete process.env.MARKETSTACK_API_KEY;
  delete process.env.TIINGO_API_KEY;
  delete process.env.ROIC_API_KEY;
  delete process.env.ROIC_HISTORY_ENABLED;
  delete process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY;
  delete process.env.ALPACA_PAPER_API_KEY;
  delete process.env.ALPACA_PAPER_SECRET_KEY;
  delete process.env.ALPACA_API_KEY;
  delete process.env.ALPACA_SECRET_KEY;
  delete process.env.ALPACA_LIVE_API_KEY;
  delete process.env.ALPACA_LIVE_SECRET_KEY;
  delete process.env.CONGRESS_TRADE_READS_ENABLED;
  resetProviderQuotaState("tiingo");
  resetProviderQuotaState("roic");
  resetProviderQuotaState("twelvedata");
  delete process.env.MASSIVE_LOCAL_HISTORY_ENABLED;
  delete process.env.TWELVEDATA_API_KEY;
  // Tiingo is per-user-only tier (db-api-keys.ts) — a prior test's upsertUserApiKey("local", "tiingo", …)
  // would otherwise persist across tests sharing historyTestDb, same concern as the Tradier row below.
  deleteUserApiKey("local", "tiingo");
  deleteUserApiKey("local", "twelvedata");
  deleteUserApiKey("local", "alpaca_paper_api_key");
  deleteUserApiKey("local", "alpaca_paper_secret_key");
  // Tradier's credential now comes from a connected_accounts row, not an env var — a prior test's
  // connectTradier() call would otherwise persist across tests sharing historyTestDb (unlike the
  // deleted env vars above, which reset per-test on their own).
  getDb().exec("DELETE FROM connected_accounts WHERE broker IN ('tradier', 'alpaca', 'alpaca-mcp')");
});
afterEach(() => vi.unstubAllGlobals());

// Tradier's price-history credential comes from the "local" (owner's) connected broker account, not
// a stored API key — see resolveTradierHistoryCredential in src/lib/history.ts. Connects a fresh
// account each call; upsertConnectedAccount deactivates any prior active row for the user first, so
// this is safe to call repeatedly across tests sharing historyTestDb.
function connectTradier(token: string, environment: "paper" | "live" = "live", isActive = true): void {
  upsertConnectedAccount({
    id: `trd-history-${randomUUID()}`,
    userId: "local",
    broker: "tradier",
    environment,
    label: "Tradier Brokerage",
    apiKey: token,
    isActive
  });
}

describe("toBusinessDay", () => {
  it("normalizes ms-epoch, seconds-epoch, and date strings to YYYY-MM-DD", () => {
    expect(toBusinessDay(Date.UTC(2026, 5, 18))).toBe("2026-06-18"); // ms
    expect(toBusinessDay(Math.floor(Date.UTC(2026, 5, 18) / 1000))).toBe("2026-06-18"); // seconds
    expect(toBusinessDay("2026-06-18")).toBe("2026-06-18");
    expect(toBusinessDay("2026-06-18T14:00:00Z")).toBe("2026-06-18");
    expect(toBusinessDay(undefined)).toBeUndefined();
    expect(toBusinessDay("garbage")).toBeUndefined();
  });
});

describe("parseRoicStockPrices", () => {
  it("maps ROIC v3 stock-prices rows and sorts ascending by date", () => {
    const bars = parseRoicStockPrices([
      { date: "2026-06-17", open: 11, high: 12, low: 10, close: 11.5, volume: 2000 },
      { date: "2026-06-16", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
      { date: "bad", close: "x" },
      null,
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ time: "2026-06-16", close: 10.5, volume: 1000, open: 10 });
    expect(bars[1]).toMatchObject({ time: "2026-06-17", close: 11.5, volume: 2000 });
  });

  it("returns [] for non-array payloads", () => {
    expect(parseRoicStockPrices(null)).toEqual([]);
    expect(parseRoicStockPrices({ data: [] })).toEqual([]);
  });
});

describe("parseStooqCsv", () => {
  it("parses daily OHLC rows and skips the header", () => {
    const csv = `Date,Open,High,Low,Close,Volume
2026-06-16,10,11,9,10.5,1000
2026-06-17,10.5,12,10,11.8,2000`;
    const out = parseStooqCsv(csv);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ open: 10, high: 11, low: 9, close: 10.5, time: "2026-06-16" });
  });
});

describe("fetchDailyOHLC", () => {
  const tradierBody = JSON.stringify({
    history: {
      day: [
        { date: "2026-06-16", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
        { date: "2026-06-17", open: 10.5, high: 12, low: 10, close: 11.8, volume: 2000 }
      ]
    }
  });

  const marketstackBody = JSON.stringify({
    data: [
      { date: "2026-06-16T00:00:00+0000", open: 20, high: 21, low: 19, close: 20.5, volume: 3000 },
      { date: "2026-06-17T00:00:00+0000", open: 20.5, high: 22, low: 20, close: 21.8, volume: 4000 }
    ]
  });

  // Second bar has a 2:1 split between raw close (60) and adjClose (30) — exercises the O/H/L scaling.
  const tiingoBody = JSON.stringify([
    { date: "2026-06-16T00:00:00.000Z", open: 30, high: 31, low: 29, close: 30, volume: 3000, adjOpen: 30, adjHigh: 31, adjLow: 29, adjClose: 30, adjVolume: 3000 },
    { date: "2026-06-17T00:00:00.000Z", open: 62, high: 64, low: 60, close: 60, volume: 4000, adjOpen: 31, adjHigh: 32, adjLow: 30, adjClose: 30, adjVolume: 8000 }
  ]);

  const yahooBody = (n: number) => {
    const timestamp = Array.from({ length: n }, (_, i) => Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86_400);
    const arr = (base: number) => Array.from({ length: n }, (_, i) => base + i);
    const quote = [{ open: arr(100), high: arr(101), low: arr(99), close: arr(100), volume: arr(1000) }];
    return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote } }] } });
  };

  it("uses connected-broker history (Tradier) before paid third parties and free Yahoo", async () => {
    connectTradier("tradier-test-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.now(), undefined, { lookbackDays: 365 });
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16", close: 10.5, volume: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.tradier.com");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer tradier-test-key" });
  });

  it("still uses Tradier for history when it's connected but NOT the active execution broker (Codex review, PR #1673)", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    // Alpaca is the account the user actually trades through (active); Tradier is connected
    // purely as a shared data source. "isActive" means "the currently loaded execution broker,"
    // an orthogonal concept to "this credential exists and can source history" — requiring
    // Tradier to ALSO be the active broker would silently disable this exact, intended setup.
    upsertConnectedAccount({
      id: `alpaca-history-${randomUUID()}`,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      label: "Alpaca Paper",
      apiKey: "alpaca-key",
      apiSecret: "alpaca-secret",
      isActive: true
    });
    connectTradier("tradier-inactive-key", "live", false); // connected, but not active
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.now(), undefined, { lookbackDays: 365 });
    expect(bars).not.toBeNull();
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer tradier-inactive-key" });
  });

  it("uses Alpaca daily bars from a connected account before paid third parties", async () => {
    upsertConnectedAccount({
      id: `alpaca-history-${randomUUID()}`,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      label: "Alpaca Paper",
      apiKey: "alpaca-hist-key",
      apiSecret: "alpaca-hist-secret",
      isActive: true
    });
    process.env.MASSIVE_API_KEY = "massive-should-not-be-called";
    const alpacaBody = JSON.stringify({
      bars: [
        { t: "2026-06-16T04:00:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 1000 },
        { t: "2026-06-17T04:00:00Z", o: 10.5, h: 12, l: 10, c: 11.8, v: 2000 }
      ]
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes("data.alpaca.markets")
        ? new Response(alpacaBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.now(), undefined, { lookbackDays: 365 });
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16", close: 10.5, volume: 1000 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("data.alpaca.markets/v2/stocks/AAPL/bars");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "APCA-API-KEY-ID": "alpaca-hist-key",
      "APCA-API-SECRET-KEY": "alpaca-hist-secret"
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("massive"))).toBe(false);
  });

  it("uses ROIC.ai after broker/Massive miss when ROIC_API_KEY is set", async () => {
    // Ensure earlier keyed tiers do not short-circuit: no broker/Massive keys, ROIC wins.
    delete process.env.MASSIVE_API_KEY;
    delete process.env.TIINGO_API_KEY;
    delete process.env.MARKETSTACK_API_KEY;
    process.env.ROIC_API_KEY = "roic-history-test-key";
    process.env.ROIC_HISTORY_ENABLED = "on";
    const roicBody = JSON.stringify({
      data: [
        { date: "2026-06-16", open: 40, high: 41, low: 39, close: 40.5, volume: 5000 },
        { date: "2026-06-17", open: 40.5, high: 42, low: 40, close: 41.2, volume: 6000 },
      ],
      next_page_url: null,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("api.roic.ai/v3.0.0/stock-prices/")) {
        return new Response(roicBody, { status: 200 });
      }
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16", close: 40.5, volume: 5000 });
    expect(bars![1]).toMatchObject({ time: "2026-06-17", close: 41.2 });
    const roicCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.roic.ai"));
    expect(roicCall).toBeTruthy();
    expect(String(roicCall![0])).toContain("adjustment=splits");
    expect(String(roicCall![0])).toContain("apikey=roic-history-test-key");
  });

  it("uses Tiingo ahead of Marketstack, applying adjClose-scaled O/H/L", async () => {
    // Tiingo is a "per-user-only" credential tier (db-api-keys.ts) — TIINGO_API_KEY only reaches
    // resolveApiKeyWithSource via the one-time env→DB migration at startup, not a live per-call env
    // read (unlike Marketstack/Massive, which ARE shared-operator-infra). Store it the same way the
    // Connections page / that migration would, on the "local" user resolveApiKeyWithSource falls back
    // to when no specific userId is passed (the background/scan-time call shape fetchDailyOHLC uses here).
    upsertUserApiKey("local", "tiingo", "tiingo-history-test-key");
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key"; // present but must be skipped — Tiingo wins first
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("api.tiingo.com")) return new Response(tiingoBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16", close: 30, volume: 3000 });
    // Second bar: adjClose(30)/close(60) = 0.5 factor scales raw open/high/low onto the adjusted basis.
    expect(bars![1]).toMatchObject({ time: "2026-06-17", open: 31, high: 32, low: 30, close: 30, volume: 8000 });
    const tiingoCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.tiingo.com"));
    expect(tiingoCall).toBeTruthy();
    expect(String(tiingoCall![0])).toContain("api.tiingo.com/tiingo/daily/aapl/prices");
    expect(tiingoCall![1]?.headers).toMatchObject({ Authorization: "Token tiingo-history-test-key" });
    // Marketstack must never be reached — Tiingo already satisfied the cascade.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.marketstack.com"))).toBe(false);
  });

  it("falls through to Marketstack when Tiingo's hourly/daily budget is already exhausted", async () => {
    upsertUserApiKey("local", "tiingo", "tiingo-history-test-key");
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key";
    // Drain the SAME "tiingo" quota bucket TiingoEnrichmentProvider would share, from outside this call.
    const credKey = await apiKeyFingerprint("tiingo-history-test-key");
    admitProviderRequests("tiingo", credKey, 50); // exhausts the 50/hour default
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      // Yahoo free floor is tried before Marketstack last_resort; fail it so Marketstack wins.
      if (String(url).includes("query1.finance.yahoo.com")) return new Response("yahoo down", { status: 500 });
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source (Tiingo should have been skipped, not called)", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ close: 20.5 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.tiingo.com"))).toBe(false);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const yahooIdx = urls.findIndex((url) => url.includes("query1.finance.yahoo.com"));
    const marketstackIdx = urls.findIndex((url) => url.includes("api.marketstack.com"));
    expect(yahooIdx).toBeGreaterThanOrEqual(0);
    expect(marketstackIdx).toBeGreaterThan(yahooIdx);
  });

  it("prefers Yahoo range=max over Tradier and Marketstack on a >2y request", async () => {
    connectTradier("tradier-test-key");
    process.env.MASSIVE_API_KEY = "massive-should-not-be-called";
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key";
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("query1.finance.yahoo.com")) return new Response(yahooBody(60), { status: 200 });
      if (String(url).includes("api.tradier.com")) return new Response(tradierBody, { status: 200 });
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.UTC(2026, 5, 18));
    expect(bars).not.toBeNull();
    expect(bars!.length).toBe(60);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("query1.finance.yahoo.com") && url.includes("range=max"))).toBe(true);
    expect(urls.some((url) => url.includes("api.tradier.com"))).toBe(false);
    expect(urls.some((url) => url.includes("massive"))).toBe(false);
    expect(urls.some((url) => url.includes("api.marketstack.com"))).toBe(false);
  });

  it("calls Yahoo before Marketstack when only a Marketstack key is present; Marketstack only if Yahoo fails", async () => {
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key";
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("query1.finance.yahoo.com")) return new Response("yahoo down", { status: 500 });
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ close: 20.5 });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const yahooIdx = urls.findIndex((url) => url.includes("query1.finance.yahoo.com"));
    const marketstackIdx = urls.findIndex((url) => url.includes("api.marketstack.com"));
    expect(yahooIdx).toBeGreaterThanOrEqual(0);
    expect(marketstackIdx).toBeGreaterThan(yahooIdx);
  });

  it("fails Yahoo 429s faster when Marketstack can still run as last_resort", async () => {
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key";
    let yahooCalls = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("query1.finance.yahoo.com")) {
        yahooCalls++;
        return new Response("Too Many Requests", { status: 429 });
      }
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ close: 20.5 });
    // Fast-fail path: 1 initial + 1 retry (not the terminal-floor 4× budget).
    expect(yahooCalls).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.marketstack.com"))).toBe(true);
  });

  it("skips Massive when the local REST budget is exhausted and falls through to free history", async () => {
    process.env.MASSIVE_API_KEY = "massive-test-key";
    process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE = "0";
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com") ? new Response(yahooBody(60), { status: 200 }) : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.UTC(2026, 5, 18));

    expect(bars).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("query1.finance.yahoo.com");
  });

  it("fetches Yahoo OHLC and caches the result (one network call across two reads)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com") ? new Response(yahooBody(60), { status: 200 }) : new Response("nope", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.UTC(2026, 5, 18);
    const first = await fetchDailyOHLC("AAPL", now);
    expect(first).not.toBeNull();
    expect(first!.length).toBe(60);
    expect(first![0]).toMatchObject({ open: 100, high: 101, low: 99, close: 100 });

    const second = await fetchDailyOHLC("AAPL", now + 1000); // within TTL → cache hit
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a Yahoo HTTP 429 with exponential backoff before succeeding, instead of giving up after one try", async () => {
    let yahooCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes("query1.finance.yahoo.com")) return new Response("unexpected source", { status: 500 });
      yahooCalls++;
      if (yahooCalls < 3) return new Response("Too Many Requests", { status: 429 });
      return new Response(yahooBody(60), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("YHOO429", Date.UTC(2026, 5, 18));
    expect(bars).not.toBeNull();
    expect(bars!.length).toBe(60);
    expect(yahooCalls).toBe(3); // two 429s, then a 200 on the third attempt
  });

  it("gives up and returns null (never fabricates) after exhausting Yahoo 429 retries", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com")
        ? new Response("Too Many Requests", { status: 429 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("YHOODEAD", Date.UTC(2026, 5, 18));
    expect(bars).toBeNull();
    const yahooCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("query1.finance.yahoo.com"));
    expect(yahooCalls).toHaveLength(4); // 1 initial attempt + 3 retries, all 429 — then gives up honestly
  });

  it("does not expire a Saturday-written cache entry before Monday's open (LANE A weekend-stable TTL)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com") ? new Response(yahooBody(60), { status: 200 }) : new Response("nope", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const saturday = Date.UTC(2026, 5, 20, 12, 0, 0); // Sat 2026-06-20, noon UTC (8am EDT — still Saturday)
    const sunday = Date.UTC(2026, 5, 21, 12, 0, 0); // Sun 2026-06-21, noon UTC — 24h later, well past the
    // naive 30-min OHLC TTL, but still inside the same weekend closed stretch.

    const first = await fetchDailyOHLC("AAPL", saturday);
    expect(first).not.toBeNull();

    const second = await fetchDailyOHLC("AAPL", sunday);
    expect(second).toBe(first); // still cached — the market hasn't traded since Saturday
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares Tradier's connected-account-sourced history across users (always shared, not per-user)", async () => {
    connectTradier("env-tradier-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 5, 18);

    const first = await fetchDailyOHLC("AAPL", now, `user-a-${randomUUID()}`, { lookbackDays: 365 });
    const second = await fetchDailyOHLC("AAPL", now + 1000, `user-b-${randomUUID()}`, { lookbackDays: 365 });

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer env-tradier-key" });
  });

  it("keeps user-keyed history cache entries private when both users decline the data pool", async () => {
    const userA = `history-user-a-${randomUUID()}`;
    const userB = `history-user-b-${randomUUID()}`;
    // Mandatory share is off until accept; explicit decline keeps user-keyed history private.
    setDataPoolConsent(userA, false);
    setDataPoolConsent(userB, false);
    upsertUserApiKey(userA, "marketstack", "user-a-marketstack-key");
    upsertUserApiKey(userB, "marketstack", "user-b-marketstack-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      // Yahoo free floor runs before Marketstack; fail it so the keyed last_resort path is exercised.
      if (String(url).includes("query1.finance.yahoo.com")) return new Response("yahoo down", { status: 500 });
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 5, 18);

    await fetchDailyOHLC("AAPL", now, userA);
    await fetchDailyOHLC("AAPL", now + 1000, userB);

    const marketstackUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("api.marketstack.com"));
    expect(marketstackUrls).toEqual([
      expect.stringContaining("access_key=user-a-marketstack-key"),
      expect.stringContaining("access_key=user-b-marketstack-key")
    ]);
  });

  it("shares user-keyed history only when explicitly opted in", async () => {
    process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY = "on";
    const userA = `history-shared-a-${randomUUID()}`;
    const userB = `history-shared-b-${randomUUID()}`;
    upsertUserApiKey(userA, "marketstack", "user-a-marketstack-key");
    upsertUserApiKey(userB, "marketstack", "user-b-marketstack-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("query1.finance.yahoo.com")) return new Response("yahoo down", { status: 500 });
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 5, 18);

    const first = await fetchDailyOHLC("AAPL", now, userA);
    const second = await fetchDailyOHLC("AAPL", now + 1000, userB);

    expect(second).toBe(first);
    const marketstackUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("api.marketstack.com"));
    expect(marketstackUrls).toHaveLength(1);
    expect(marketstackUrls[0]).toContain("access_key=user-a-marketstack-key");
  });

  it("fulfills old shared history misses when a later shared cache fill succeeds", async () => {
    const events: DashboardEvent[] = [];
    const unsubscribe = subscribeDashboardEvents((event) => events.push(event));
    const now = Date.UTC(2026, 5, 18);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    await expect(fetchDailyOHLC("XYZ", now, `alice-${randomUUID()}`)).resolves.toBeNull();

    connectTradier("env-tradier-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchDailyOHLC("XYZ", now + 120_000, `frank-${randomUUID()}`);
    unsubscribe();

    expect(bars).not.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "market-data",
        detail: expect.objectContaining({ kind: "history", cacheScope: "shared", pendingUserCount: 1 })
      })
    );
  });

  it("does not fulfill old shared history misses from private user-key fills", async () => {
    const events: DashboardEvent[] = [];
    const unsubscribe = subscribeDashboardEvents((event) => events.push(event));
    const now = Date.UTC(2026, 5, 18);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    await expect(fetchDailyOHLC("XYZ", now, `alice-${randomUUID()}`)).resolves.toBeNull();

    const frank = `frank-${randomUUID()}`;
    upsertUserApiKey(frank, "marketstack", "frank-marketstack-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.marketstack.com")
        ? new Response(marketstackBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchDailyOHLC("XYZ", now + 120_000, frank);
    unsubscribe();

    expect(bars).not.toBeNull();
    expect(events.filter((event) => event.type === "market-data")).toHaveLength(0);
  });

  it("no longer falls back to Stooq when Yahoo yields nothing (tier removed 2026-08 — bot-walled)", async () => {
    const stooq = `Date,Open,High,Low,Close,Volume\n2026-06-16,10,11,9,10.5,1000\n2026-06-17,10.5,12,10,11.8,2000`;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("query1.finance.yahoo.com")) return new Response(JSON.stringify({ chart: { result: [{}] } }), { status: 200 });
      if (String(url).includes("stooq.com")) return new Response(stooq, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchDailyOHLC("BBB");
    expect(bars).toBeNull();
    // Stooq must never even be called — its endpoint sits behind a proof-of-work bot wall.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("stooq.com"))).toBe(false);
  });

  it("returns null when no source has data (never fabricates)", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    expect(await fetchDailyOHLC("ZZZ")).toBeNull();
  });

  it("uses Twelve Data after Yahoo and Tradier miss on a >2y request, and still skips Massive", async () => {
    connectTradier("tradier-test-key");
    process.env.MASSIVE_API_KEY = "massive-should-not-be-called";
    upsertUserApiKey("local", "twelvedata", "twelve-history-test-key");
    const twelveBody = JSON.stringify({
      status: "ok",
      values: [
        { datetime: "2021-06-16", open: "10", high: "11", low: "9", close: "10.5", volume: "1000" },
        { datetime: "2026-06-17", open: "10.5", high: "12", low: "10", close: "11.8", volume: "2000" }
      ]
    });
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("api.twelvedata.com/time_series")) return new Response(twelveBody, { status: 200 });
      return new Response("miss", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.UTC(2026, 5, 18));
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ time: "2021-06-16", close: 10.5, volume: 1000 });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const yahooIdx = urls.findIndex((url) => url.includes("query1.finance.yahoo.com") && url.includes("range=max"));
    const tradierIdx = urls.findIndex((url) => url.includes("api.tradier.com"));
    const twelveIdx = urls.findIndex((url) => url.includes("api.twelvedata.com/time_series"));
    expect(yahooIdx).toBeGreaterThanOrEqual(0);
    expect(tradierIdx).toBeGreaterThan(yahooIdx);
    expect(twelveIdx).toBeGreaterThan(tradierIdx);
    expect(urls[twelveIdx]).toContain("start_date=");
    expect(urls[twelveIdx]).toContain("apikey=twelve-history-test-key");
    expect(urls.some((url) => url.includes("massive"))).toBe(false);
  });

  it("keeps Massive ahead of Yahoo when the lookback is within 2 years", async () => {
    process.env.MASSIVE_API_KEY = "massive-short-key";
    const massiveBody = JSON.stringify({
      results: [
        { t: Date.parse("2026-06-16T00:00:00Z"), o: 10, h: 11, l: 9, c: 10.5, v: 1000 },
        { t: Date.parse("2026-06-17T00:00:00Z"), o: 10.5, h: 12, l: 10, c: 11.8, v: 2000 }
      ]
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/v2/aggs/")
        ? new Response(massiveBody, { status: 200 })
        : new Response("unexpected", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.UTC(2026, 5, 18), undefined, { lookbackDays: 365 });
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ close: 10.5 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v2/aggs/");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("query1.finance.yahoo.com"))).toBe(false);
  });

  it("serves a fresh covering SQLite series with no network, and does not let a short series block Yahoo range=max", async () => {
    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "on";
    const now = Date.UTC(2026, 5, 18, 21, 0, 0);
    const latest = latestCompletedTradingSessionEtKey(now);
    const db = getDb();
    upsertHistoryCacheEod("LONGHIST", [
      { time: "2019-01-02", open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: latest, open: 20, high: 21, low: 19, close: 20, volume: 200 }
    ]);
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      throw new Error(`network should not run for ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const covered = await fetchDailyOHLC("LONGHIST", now);
      expect(covered).not.toBeNull();
      expect(covered![0]).toMatchObject({ close: 10 });
      expect(fetchMock).not.toHaveBeenCalled();

      clearHistoryCache();
      upsertHistoryCacheEod("SHORTHIST", [
        { time: "2026-06-17", open: 1, high: 2, low: 1, close: 1.5, volume: 10 },
        { time: latest, open: 2, high: 3, low: 2, close: 2.5, volume: 20 }
      ]);
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("query1.finance.yahoo.com")
          ? new Response(yahooBody(60), { status: 200 })
          : new Response("nope", { status: 500 })
      );
      const short = await fetchDailyOHLC("SHORTHIST", now);
      expect(short).not.toBeNull();
      expect(short!.length).toBeGreaterThanOrEqual(2);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("range=max"))).toBe(true);
    } finally {
      db.prepare("DELETE FROM history_cache_eod WHERE ticker IN ('LONGHIST', 'SHORTHIST')").run();
      delete process.env.MASSIVE_LOCAL_HISTORY_ENABLED;
    }
  });

  it("does not refetch Yahoo range=max every TTL when the listing starts inside the window", async () => {
    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "on";
    const now = Date.UTC(2026, 5, 18, 21, 0, 0);
    const latest = latestCompletedTradingSessionEtKey(now);
    const symbol = "IPONEW";
    const body = JSON.stringify({
      chart: {
        result: [{
          timestamp: [
            Math.floor(Date.parse("2024-01-02T00:00:00Z") / 1000),
            Math.floor(Date.parse(`${latest}T00:00:00Z`) / 1000)
          ],
          indicators: {
            quote: [{ open: [10, 12], high: [11, 13], low: [9, 11], close: [10.5, 12.5], volume: [100, 200] }]
          }
        }]
      }
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com")
        ? new Response(body, { status: 200 })
        : new Response("nope", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await fetchDailyOHLC(symbol, now);
      expect(first).not.toBeNull();
      expect(toBusinessDay(first![0].time)).toBe("2024-01-02");
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("range=max"))).toBe(true);
      const callsAfterFirst = fetchMock.mock.calls.length;
      clearHistoryCache();
      const second = await fetchDailyOHLC(symbol, now + 31 * 60_000);
      expect(second).not.toBeNull();
      expect(toBusinessDay(second![0].time)).toBe("2024-01-02");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      getDb().prepare("DELETE FROM history_cache_eod WHERE ticker = ?").run(symbol);
      deleteInternalSetting(`history:listing-start:${symbol}`);
      delete process.env.MASSIVE_LOCAL_HISTORY_ENABLED;
    }
  });

  it("rejects a Twelve Data body that is not a time series and accepts numeric closes", async () => {
    upsertUserApiKey("local", "twelvedata", "twelve-history-test-key");
    const now = Date.UTC(2026, 5, 18);
    const malformed = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("api.twelvedata.com/time_series")) {
        return new Response(JSON.stringify({ status: "ok", values: { datetime: "2021-06-16" } }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    });
    vi.stubGlobal("fetch", malformed);
    await expect(fetchDailyOHLC("AAPL", now)).resolves.toBeNull();
    expect(malformed.mock.calls.some(([url]) => String(url).includes("api.twelvedata.com"))).toBe(true);

    const numeric = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("api.twelvedata.com/time_series")) {
        return new Response(JSON.stringify({
          status: "ok",
          values: [
            { datetime: "2021-06-16", close: 10.5, volume: 1000 },
            { datetime: "2026-06-17", close: 11.8, volume: 2000 }
          ]
        }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    });
    vi.stubGlobal("fetch", numeric);
    const bars = await fetchDailyOHLC("AAPL", now);
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ time: "2021-06-16", close: 10.5 });
  });

  it("serves local SQLite OHLC history directly without network requests", async () => {
    const { fetchHistoryCacheEod, upsertHistoryCacheEod } = await import("../src/lib/history-cache");
    const { getDb } = await import("../src/lib/db");

    // Ensure the table exists for testing
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS history_cache_eod (
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL NOT NULL,
        volume REAL,
        vwap REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ticker, date)
      );
    `);

    // Insert dummy bars using the real upsert function
    upsertHistoryCacheEod("TESTSYM", [
      { time: "2021-01-01", open: 100, high: 105, low: 99, close: 104, volume: 1000 },
      { time: "2021-01-02", open: 104, high: 108, low: 103, close: 107, volume: 1500 }
    ]);

    try {
      const bars = fetchHistoryCacheEod("TESTSYM");
      expect(bars).not.toBeNull();
      expect(bars).toHaveLength(2);
      expect(bars![0].close).toBe(104);
      expect(bars![1].close).toBe(107);
    } finally {
      getDb().prepare("DELETE FROM history_cache_eod WHERE ticker = ?").run("TESTSYM");
    }
  });
});

describe("fetchDailyOHLC App A tier skip (peer-serving reads)", () => {
  const appABody = JSON.stringify({
    ticker: "AAPL",
    closes: [
      { date: "2026-06-17", close: 11.8 },
      { date: "2026-06-16", close: 10.5 }
    ]
  });

  const yahooBody = () => {
    const n = 250;
    const timestamp = Array.from({ length: n }, (_, i) => Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86_400);
    const arr = (base: number) => Array.from({ length: n }, (_, i) => base + i);
    const quote = [{ open: arr(100), high: arr(101), low: arr(99), close: arr(100), volume: arr(1000) }];
    return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote } }] } });
  };

  beforeEach(() => {
    process.env.CONGRESS_TRADE_READS_ENABLED = "on";
  });
  afterEach(() => {
    delete process.env.CONGRESS_TRADE_READS_ENABLED;
  });

  it("consults the App A tier by default when reads are enabled (control)", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("congress.trade")
        ? new Response(appABody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).toHaveLength(2);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("congress.trade"))).toBe(true);
  });

  it("skipAppATier never echoes the request back to App A and still serves from later tiers", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("finance.yahoo.com")
        ? new Response(yahooBody(), { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.now(), undefined, { skipAppATier: true });
    expect(bars).not.toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("congress.trade"))).toBe(false);
  });
});

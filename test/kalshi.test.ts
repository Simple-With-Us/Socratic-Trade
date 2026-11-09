// Kalshi event-data fetcher unit tests. global.fetch is stubbed to canned Kalshi REST payloads —
// no network. Signing correctness is verified with a keypair generated via node:crypto (RSA-PSS is
// salted/non-deterministic, so we verify signatures rather than compare fixed bytes, and assert
// the exact covered message by reconstructing it for crypto.verify).

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  centsToProbability,
  clearKalshiCacheForTests,
  fetchKalshiEvent,
  fetchKalshiMarkets,
  fetchKalshiSeries,
  getKalshiConfig,
  getKalshiEventSignals,
  impliedProbability,
  isKalshiConfigured,
  kalshiApiBase,
  kalshiAuthHeaders,
  signKalshiRequest
} from "../src/lib/kalshi";

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = PRIVATE_KEY.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "test-key-id-1234";

const KALSHI_ENV_VARS = ["KALSHI_ENV", "KALSHI_API_KEY_ID", "KALSHI_PRIVATE_KEY_PEM"] as const;

function verifyPss(message: string, signatureB64: string): boolean {
  return crypto.verify("sha256", Buffer.from(message, "utf8"), {
    key: PUBLIC_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }, Buffer.from(signatureB64, "base64"));
}

interface FetchRecord {
  url: string;
  method: string;
  headers: Headers;
}

/** Stub global fetch; `handler` maps a URL to { status, body } (throw to simulate network error). */
function installFetchMock(handler: (url: string) => { status?: number; body: unknown } | { raw: string }): { records: FetchRecord[] } {
  const records: FetchRecord[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    records.push({ url: u, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers) });
    const result = handler(u);
    if ("raw" in result) {
      return new Response(result.raw, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  return { records };
}

function openMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: "KXFEDDECISION-26SEP-C25",
    event_ticker: "KXFEDDECISION-26SEP",
    title: "Fed decision in September 2026?",
    subtitle: "Cut of 25bps",
    status: "open",
    // Current API representation: *_dollars fixed-point strings.
    yes_bid_dollars: "0.42",
    yes_ask_dollars: "0.46",
    last_price_dollars: "0.43",
    // Legacy integer-cent fields (may still be present in some environments).
    yes_bid: 42,
    yes_ask: 46,
    last_price: 43,
    volume: 120_000,
    volume_24h: 15_000,
    open_interest_fp: 80_000,
    open_interest: 80_000,
    close_time: "2026-09-17T18:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearKalshiCacheForTests();
  for (const name of KALSHI_ENV_VARS) delete process.env[name];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of KALSHI_ENV_VARS) delete process.env[name];
});

describe("getKalshiConfig / isKalshiConfigured", () => {
  it("is inert (undefined/false) when KALSHI_ENV is absent", () => {
    expect(getKalshiConfig()).toBeUndefined();
    expect(isKalshiConfigured()).toBe(false);
  });

  it("is inert on an invalid KALSHI_ENV value", () => {
    process.env.KALSHI_ENV = "sandbox";
    expect(getKalshiConfig()).toBeUndefined();
  });

  it("selects the demo base URL for KALSHI_ENV=demo", () => {
    process.env.KALSHI_ENV = "demo";
    const config = getKalshiConfig();
    expect(config?.env).toBe("demo");
    expect(config?.baseUrl).toBe("https://external-api.demo.kalshi.co/trade-api/v2");
    expect(config?.keyId).toBeUndefined();
  });

  it("selects the prod base URL for KALSHI_ENV=prod (case/whitespace tolerant)", () => {
    process.env.KALSHI_ENV = " Prod ";
    const config = getKalshiConfig();
    expect(config?.env).toBe("prod");
    expect(config?.baseUrl).toBe("https://external-api.kalshi.com/trade-api/v2");
    expect(kalshiApiBase("prod")).toBe("https://external-api.kalshi.com/trade-api/v2");
  });

  it("attaches credentials only when BOTH key id and PEM are present, normalizing literal \\n", () => {
    process.env.KALSHI_ENV = "prod";
    process.env.KALSHI_API_KEY_ID = KEY_ID;
    expect(getKalshiConfig()?.keyId).toBeUndefined(); // PEM missing => unsigned public access only
    process.env.KALSHI_PRIVATE_KEY_PEM = PRIVATE_PEM.replace(/\n/g, "\\n");
    const config = getKalshiConfig();
    expect(config?.keyId).toBe(KEY_ID);
    expect(config?.privateKeyPem).toContain("\n");
    expect(config?.privateKeyPem).not.toContain("\\n");
  });
});

describe("signKalshiRequest", () => {
  it("produces a valid RSA-PSS/SHA-256 signature over timestamp + method + path", () => {
    const ts = "1767225600000";
    const sig = signKalshiRequest(PRIVATE_PEM, ts, "GET", "/trade-api/v2/markets");
    expect(verifyPss(`${ts}GET/trade-api/v2/markets`, sig)).toBe(true);
  });

  it("strips the query string from the signed path", () => {
    const ts = "1767225600000";
    const sig = signKalshiRequest(PRIVATE_PEM, ts, "GET", "/trade-api/v2/markets?series_ticker=KXFEDDECISION&status=open");
    expect(verifyPss(`${ts}GET/trade-api/v2/markets`, sig)).toBe(true);
    // The message including the query must NOT verify — proves the query is excluded.
    expect(verifyPss(`${ts}GET/trade-api/v2/markets?series_ticker=KXFEDDECISION&status=open`, sig)).toBe(false);
  });

  it("uppercases the HTTP method in the signed message", () => {
    const ts = "1767225600001";
    const sig = signKalshiRequest(PRIVATE_PEM, ts, "get", "/trade-api/v2/portfolio/balance");
    expect(verifyPss(`${ts}GET/trade-api/v2/portfolio/balance`, sig)).toBe(true);
    expect(verifyPss(`${ts}get/trade-api/v2/portfolio/balance`, sig)).toBe(false);
  });
});

describe("kalshiAuthHeaders", () => {
  it("returns the three Kalshi headers with a verifiable signature when credentials are configured", () => {
    process.env.KALSHI_ENV = "prod";
    process.env.KALSHI_API_KEY_ID = KEY_ID;
    process.env.KALSHI_PRIVATE_KEY_PEM = PRIVATE_PEM;
    const config = getKalshiConfig();
    expect(config).toBeDefined();
    const now = 1767225600123;
    const headers = kalshiAuthHeaders(config!, "GET", "/trade-api/v2/markets?limit=5", now);
    expect(headers["KALSHI-ACCESS-KEY"]).toBe(KEY_ID);
    expect(headers["KALSHI-ACCESS-TIMESTAMP"]).toBe(String(now));
    expect(verifyPss(`${now}GET/trade-api/v2/markets`, headers["KALSHI-ACCESS-SIGNATURE"]!)).toBe(true);
  });

  it("returns no headers without credentials (public endpoints stay unsigned)", () => {
    process.env.KALSHI_ENV = "demo";
    const config = getKalshiConfig();
    expect(kalshiAuthHeaders(config!, "GET", "/trade-api/v2/markets")).toEqual({});
  });
});

describe("centsToProbability / impliedProbability", () => {
  it("parses integer cents (1-99) to a probability", () => {
    expect(centsToProbability(42)).toBe(0.42);
    expect(centsToProbability(1)).toBe(0.01);
    expect(centsToProbability(99)).toBe(0.99);
  });

  it("rejects out-of-range, zero, and non-numeric cents", () => {
    expect(centsToProbability(0)).toBeUndefined(); // 0 = empty book side, not a price
    expect(centsToProbability(100)).toBeUndefined();
    expect(centsToProbability(-5)).toBeUndefined();
    expect(centsToProbability("42")).toBeUndefined(); // dollar-string fields are NOT the cent fields
    expect(centsToProbability(Number.NaN)).toBeUndefined();
    expect(centsToProbability(undefined)).toBeUndefined();
  });

  it("uses the bid/ask mid when both sides have a book", () => {
    expect(impliedProbability({ yes_bid: 42, yes_ask: 46, last_price: 90 })).toEqual({ probability: 0.44, basis: "mid" });
    expect(impliedProbability({ yes_bid: 33, yes_ask: 34 })).toEqual({ probability: 0.335, basis: "mid" });
  });

  it("falls back to last_price when the book is one-sided or empty", () => {
    expect(impliedProbability({ yes_bid: 0, yes_ask: 46, last_price: 43 })).toEqual({ probability: 0.43, basis: "last" });
    expect(impliedProbability({ last_price: 7 })).toEqual({ probability: 0.07, basis: "last" });
  });

  it("returns undefined (never fabricates) when no usable price exists", () => {
    expect(impliedProbability({ yes_bid: 0, yes_ask: 0, last_price: 0 })).toBeUndefined();
    expect(impliedProbability({})).toBeUndefined();
  });
});

describe("fetchKalshiMarkets", () => {
  it("returns null when the module is unconfigured, without calling fetch", async () => {
    const { records } = installFetchMock(() => ({ body: {} }));
    expect(await fetchKalshiMarkets({ seriesTicker: "KXFEDDECISION" })).toBeNull();
    expect(records).toHaveLength(0);
  });

  it("hits the env-derived base URL with query params and parses one page", async () => {
    process.env.KALSHI_ENV = "demo";
    const { records } = installFetchMock(() => ({ body: { markets: [openMarket()], cursor: "abc123" } }));
    const page = await fetchKalshiMarkets({ seriesTicker: "KXFEDDECISION", status: "open", limit: 200 });
    expect(records).toHaveLength(1);
    const url = new URL(records[0]!.url);
    expect(url.origin + url.pathname).toBe("https://external-api.demo.kalshi.co/trade-api/v2/markets");
    expect(url.searchParams.get("series_ticker")).toBe("KXFEDDECISION");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(page?.markets).toHaveLength(1);
    expect(page?.markets[0]?.yes_bid).toBe(42);
    expect(page?.cursor).toBe("abc123");
  });

  it("signs requests when credentials are configured and leaves them unsigned otherwise", async () => {
    process.env.KALSHI_ENV = "prod";
    const unsigned = installFetchMock(() => ({ body: { markets: [] } }));
    await fetchKalshiMarkets({});
    expect(unsigned.records[0]!.headers.get("KALSHI-ACCESS-KEY")).toBeNull();

    process.env.KALSHI_API_KEY_ID = KEY_ID;
    process.env.KALSHI_PRIVATE_KEY_PEM = PRIVATE_PEM;
    const signed = installFetchMock(() => ({ body: { markets: [] } }));
    await fetchKalshiMarkets({ tickers: ["KXCPIYOY-26-T3.0"] });
    const record = signed.records[0]!;
    expect(record.headers.get("KALSHI-ACCESS-KEY")).toBe(KEY_ID);
    const ts = record.headers.get("KALSHI-ACCESS-TIMESTAMP")!;
    expect(ts).toMatch(/^\d{13,}$/);
    expect(verifyPss(`${ts}GET/trade-api/v2/markets`, record.headers.get("KALSHI-ACCESS-SIGNATURE")!)).toBe(true);
  });

  it("returns null on HTTP errors, network failures, and malformed payloads", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock(() => ({ status: 500, body: { error: "boom" } }));
    expect(await fetchKalshiMarkets({})).toBeNull();

    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await fetchKalshiMarkets({})).toBeNull();

    installFetchMock(() => ({ raw: "not-json{{" }));
    expect(await fetchKalshiMarkets({})).toBeNull();

    installFetchMock(() => ({ body: { markets: "nope" } }));
    expect(await fetchKalshiMarkets({})).toBeNull();
  });
});

describe("fetchKalshiEvent / fetchKalshiSeries", () => {
  it("fetches one event and adopts sibling markets when not nested", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock(() => ({
      body: { event: { event_ticker: "KXFEDDECISION-26SEP", series_ticker: "KXFEDDECISION", title: "Fed decision" }, markets: [openMarket()] }
    }));
    const event = await fetchKalshiEvent("KXFEDDECISION-26SEP");
    expect(event?.event_ticker).toBe("KXFEDDECISION-26SEP");
    expect(event?.markets).toHaveLength(1);
  });

  it("fetches series metadata and URL-encodes the ticker", async () => {
    process.env.KALSHI_ENV = "prod";
    const { records } = installFetchMock(() => ({ body: { series: { ticker: "KXFEDDECISION", title: "Fed decision", category: "Economics" } } }));
    const series = await fetchKalshiSeries("KXFEDDECISION");
    expect(records[0]!.url).toContain("/trade-api/v2/series/KXFEDDECISION");
    expect(series?.category).toBe("Economics");
  });

  it("returns null on failure or blank tickers and stays inert unconfigured", async () => {
    const { records } = installFetchMock(() => ({ body: {} }));
    expect(await fetchKalshiEvent("KXFEDDECISION-26SEP")).toBeNull();
    expect(await fetchKalshiSeries("KXFEDDECISION")).toBeNull();
    expect(records).toHaveLength(0);

    process.env.KALSHI_ENV = "prod";
    expect(await fetchKalshiEvent("   ")).toBeNull();
    expect(await fetchKalshiSeries("")).toBeNull();
    installFetchMock(() => ({ status: 404, body: { error: "not found" } }));
    expect(await fetchKalshiEvent("KXNOPE")).toBeNull();
    expect(await fetchKalshiSeries("KXNOPE")).toBeNull();
  });
});

describe("getKalshiEventSignals", () => {
  it("returns [] without fetching when the module is unconfigured", async () => {
    const { records } = installFetchMock(() => ({ body: { markets: [openMarket()] } }));
    expect(await getKalshiEventSignals(["KXFEDDECISION"])).toEqual([]);
    expect(records).toHaveLength(0);
  });

  it("returns [] for an empty or junk series list", async () => {
    process.env.KALSHI_ENV = "prod";
    const { records } = installFetchMock(() => ({ body: { markets: [openMarket()] } }));
    expect(await getKalshiEventSignals([])).toEqual([]);
    expect(await getKalshiEventSignals(["", "   "])).toEqual([]);
    expect(records).toHaveLength(0);
  });

  it("normalizes open markets into probability signals (cents -> probability, title, volume, close date)", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock(() => ({ body: { markets: [openMarket()] } }));
    const signals = await getKalshiEventSignals(["kxfeddecision"]); // lowercased input is normalized
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      seriesTicker: "KXFEDDECISION",
      marketTicker: "KXFEDDECISION-26SEP-C25",
      title: "Fed decision in September 2026? — Cut of 25bps",
      probability: 0.44, // mid of 42/46 cents
      probabilityBasis: "mid",
      volume24h: 15_000,
      openInterest: 80_000,
      closeTime: "2026-09-17T18:00:00Z"
    });
    expect(typeof signals[0]!.asOf).toBe("string");
  });

  it("drops markets with no usable price and falls back to last_price for one-sided books", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock(() => ({
      body: {
        markets: [
          openMarket({ ticker: "M-MID", yes_bid_dollars: "0.30", yes_ask_dollars: "0.34", last_price_dollars: "0.90", yes_bid: 30, yes_ask: 34, last_price: 90 }),
          openMarket({ ticker: "M-LAST", yes_bid_dollars: undefined, yes_ask_dollars: undefined, last_price_dollars: "0.12", yes_bid: 0, yes_ask: 0, last_price: 12, open_interest_fp: 10, open_interest: 10 }),
          openMarket({ ticker: "M-DEAD", yes_bid_dollars: undefined, yes_ask_dollars: undefined, last_price_dollars: undefined, yes_bid: 0, yes_ask: 0, last_price: 0 }),
          openMarket({ ticker: undefined })
        ]
      }
    }));
    const signals = await getKalshiEventSignals(["KXTEST"]);
    expect(signals.map((s) => s.marketTicker)).toEqual(["M-MID", "M-LAST"]); // sorted by open interest
    expect(signals[0]).toMatchObject({ probability: 0.32, probabilityBasis: "mid" });
    expect(signals[1]).toMatchObject({ probability: 0.12, probabilityBasis: "last" });
  });

  it("caps per-series output at the most-liquid markets", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock(() => ({
      body: {
        markets: [
          openMarket({ ticker: "M-SMALL", open_interest_fp: 5, open_interest: 5 }),
          openMarket({ ticker: "M-BIG", open_interest_fp: 900, open_interest: 900 }),
          openMarket({ ticker: "M-MEDIUM", open_interest_fp: 50, open_interest: 50 })
        ]
      }
    }));
    const signals = await getKalshiEventSignals(["KXTEST"], { maxMarketsPerSeries: 2 });
    expect(signals.map((s) => s.marketTicker)).toEqual(["M-BIG", "M-MEDIUM"]);
  });

  it("fails soft per series: one failing series does not sink the batch", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock((url) =>
      url.includes("series_ticker=KXBAD") ? { status: 503, body: { error: "unavailable" } } : { body: { markets: [openMarket()] } }
    );
    const signals = await getKalshiEventSignals(["KXBAD", "KXFEDDECISION"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.seriesTicker).toBe("KXFEDDECISION");
  });

  it("returns [] when every series fails (HTTP error or network throw)", async () => {
    process.env.KALSHI_ENV = "prod";
    installFetchMock(() => ({ status: 500, body: {} }));
    expect(await getKalshiEventSignals(["KXA", "KXB"])).toEqual([]);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await getKalshiEventSignals(["KXA"])).toEqual([]);
  });

  it("serves repeat calls from the success-only cache within the TTL", async () => {
    process.env.KALSHI_ENV = "prod";
    const { records } = installFetchMock(() => ({ body: { markets: [openMarket()] } }));
    const first = await getKalshiEventSignals(["KXFEDDECISION"]);
    const second = await getKalshiEventSignals(["KXFEDDECISION"]);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(records).toHaveLength(1); // second call never re-fetched

    clearKalshiCacheForTests();
    await getKalshiEventSignals(["KXFEDDECISION"]);
    expect(records).toHaveLength(2);
  });

  it("does not cache failures (a later call retries)", async () => {
    process.env.KALSHI_ENV = "prod";
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return new Response(JSON.stringify({ markets: [openMarket()] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect(await getKalshiEventSignals(["KXFEDDECISION"])).toEqual([]);
    const retried = await getKalshiEventSignals(["KXFEDDECISION"]);
    expect(retried).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

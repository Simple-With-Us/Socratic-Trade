import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlpacaSnapshotEnrichmentProvider,
  CascadingEnrichmentProvider,
  alpacaDataFeed,
  alpacaSnapshotTtlMs,
  analystScoreFromCounts,
  analystScoreFromMean,
  apiKeyFingerprint,
  getEnrichmentProvider,
  isLatchingEnrichmentTransportError,
  isTransientError,
  labelFromAnalystScore,
  mockEnrichmentProvider,
  noopProvider,
  parseAlpacaSnapshot,
  parseRobinhoodFundamentals,
  parseWebullUnofficialQuote,
  scoreHeadlines,
  type MarketEnrichmentProvider,
  type EnrichmentContext,
  type SymbolEnrichment
} from "../src/lib/data-providers";
import { getServiceHealthLog } from "../src/lib/db-health";
import { arbitrateFieldObservation } from "../src/lib/evidence-facts";
import { deleteUserApiKey, migrateLocalEnvCredentials, upsertUserApiKey, LOCAL_USER } from "../src/lib/db-api-keys";
import { __resetAlphaVantageDailyBudgetForTests, __resetKeyPoolRegistryForTests } from "../src/lib/alpha-vantage-key-pool";
import { clearProviderFieldCacheForTests } from "../src/lib/provider-field-cache";

/** Suppresses a provider's own `/calendar/earnings`-style daysToEarnings fallback fetch (Finnhub,
 *  Alpha Vantage) by marking the field already-covered upstream — keeps pre-existing exact
 *  fetch-count assertions in tests that predate that fallback unperturbed by it (same idiom already
 *  used in milestone-4-challenger.test.ts's `skipCalendar`). */
function skipDaysToEarningsCalendar(...symbols: string[]): EnrichmentContext {
  const coveredFields: Record<string, Set<string>> = {};
  for (const s of symbols) coveredFields[s] = new Set(["daysToEarnings"]);
  return { coveredFields };
}

// Each test file gets its own isolated SQLite db so db module singleton state
// (user API keys, consent records) does not leak between test files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-data-providers-${randomUUID()}.db`)}`;
  // These tests seed provider failures then assert subsequent-call/caching behavior; the per-lane
  // circuit breaker (default ON) would otherwise trip a lane mid-file (the temp health log accumulates
  // failures across tests) and skip those follow-up calls. The breaker has its own dedicated test.
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  // These tests don't exercise real provider pacing (that lives in provider-rate-limit.test.ts) —
  // without this, Finnhub/Alpha Vantage/Yahoo calls here would inherit real-world spacing (real
  // 400ms-1.2s waits per request) since the pacer is unaware it's under test.
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

beforeEach(() => {
  clearProviderFieldCacheForTests();
});

describe("market enrichment provider", () => {
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalFmpKey = process.env.FMP_API_KEY;
  const originalAlphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;
  const originalWebullEnabled = process.env.WEBULL_UNOFFICIAL_ENABLED;
  const originalFintechKey = process.env.FINTECH_STUDIOS_API_KEY;
  const originalFintechBase = process.env.FINTECH_STUDIOS_BASE_URL;

  const originalRoicKey = process.env.ROIC_API_KEY;
  const originalMassiveKey = process.env.MASSIVE_API_KEY;
  const originalMassiveAltKey = process.env.MASSIVE_API_KEY_ALT;
  const originalRapidApiKey = process.env.RAPIDAPI_KEY;
  const originalTiingoKey = process.env.TIINGO_API_KEY;
  const originalTwelveKey = process.env.TWELVEDATA_API_KEY;

  const originalSecXbrl = process.env.SEC_XBRL_ENRICHMENT_ENABLED;
  const originalFilingApi = process.env.FILINGAPI;
  const originalFilingApiKey = process.env.FILINGAPI_KEY;

  beforeEach(() => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.WEBULL_UNOFFICIAL_ENABLED;
    delete process.env.FINTECH_STUDIOS_API_KEY;
    delete process.env.FINTECH_STUDIOS_BASE_URL;
    delete process.env.ROIC_API_KEY;
    delete process.env.MASSIVE_API_KEY;
    delete process.env.MASSIVE_API_KEY_ALT;
    delete process.env.RAPIDAPI_KEY;
    delete process.env.TIINGO_API_KEY;
    delete process.env.TWELVEDATA_API_KEY;
    delete process.env.FILINGAPI;
    delete process.env.FILINGAPI_KEY;
    // Isolate keyless-floor registration tests from default-ON SEC XBRL.
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "0";
  });

  afterEach(() => {
    if (originalFinnhubKey) process.env.FINNHUB_API_KEY = originalFinnhubKey;
    else delete process.env.FINNHUB_API_KEY;
    if (originalFmpKey) process.env.FMP_API_KEY = originalFmpKey;
    else delete process.env.FMP_API_KEY;
    if (originalAlphaVantageKey) process.env.ALPHAVANTAGE_API_KEY = originalAlphaVantageKey;
    else delete process.env.ALPHAVANTAGE_API_KEY;
    if (originalWebullEnabled) process.env.WEBULL_UNOFFICIAL_ENABLED = originalWebullEnabled;
    else delete process.env.WEBULL_UNOFFICIAL_ENABLED;
    if (originalFintechKey) process.env.FINTECH_STUDIOS_API_KEY = originalFintechKey;
    else delete process.env.FINTECH_STUDIOS_API_KEY;
    if (originalFintechBase) process.env.FINTECH_STUDIOS_BASE_URL = originalFintechBase;
    else delete process.env.FINTECH_STUDIOS_BASE_URL;
    if (originalRoicKey) process.env.ROIC_API_KEY = originalRoicKey;
    else delete process.env.ROIC_API_KEY;
    if (originalMassiveKey) process.env.MASSIVE_API_KEY = originalMassiveKey;
    else delete process.env.MASSIVE_API_KEY;
    if (originalMassiveAltKey) process.env.MASSIVE_API_KEY_ALT = originalMassiveAltKey;
    else delete process.env.MASSIVE_API_KEY_ALT;
    if (originalRapidApiKey) process.env.RAPIDAPI_KEY = originalRapidApiKey;
    else delete process.env.RAPIDAPI_KEY;
    if (originalTiingoKey) process.env.TIINGO_API_KEY = originalTiingoKey;
    else delete process.env.TIINGO_API_KEY;
    if (originalTwelveKey) process.env.TWELVEDATA_API_KEY = originalTwelveKey;
    else delete process.env.TWELVEDATA_API_KEY;
    if (originalSecXbrl === undefined) delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    else process.env.SEC_XBRL_ENRICHMENT_ENABLED = originalSecXbrl;
    if (originalFilingApi === undefined) delete process.env.FILINGAPI;
    else process.env.FILINGAPI = originalFilingApi;
    if (originalFilingApiKey === undefined) delete process.env.FILINGAPI_KEY;
    else process.env.FILINGAPI_KEY = originalFilingApiKey;
  });

  it("uses Yahoo Finance provider when no API key is configured", async () => {
    // Keyless free-wave floor; fundamentals from multi-source cascade (no FMP/Quiver/App A by default).
    const provider = getEnrichmentProvider();
    expect(provider.configured).toBe(true);
    expect(provider.name).toContain("yahoo-finance");
    expect(provider.name).toContain("nasdaq-quote");
    expect(provider.name).not.toContain("congress.trade");
    expect(provider.name).not.toMatch(/(^|\+)fmp($|\+)/);
    expect(provider.name).not.toContain("quiverquant");
  });

  it("keeps the unofficial Webull quote bridge disabled by default", async () => {
    const provider = getEnrichmentProvider();
    expect(provider.name).not.toContain("webull-unofficial");
  });

  it("adds the unofficial Webull quote bridge only when explicitly enabled", async () => {
    process.env.WEBULL_UNOFFICIAL_ENABLED = "on";
    const provider = getEnrichmentProvider();
    expect(provider.name).toContain("webull-unofficial");
    expect(provider.name).toContain("yahoo-finance");
  });

  it("parses unofficial Webull quote payloads as market data only", () => {
    const parsed = parseWebullUnofficialQuote({
      close: "205.50",
      bid: "205.40",
      ask: "205.60",
      preClose: "203.20",
      volume: "1500000",
      peTtm: "36.05",
      epsTtm: "8.27",
      pb: "41.05",
      yield: "0.0036",
      fiftyTwoWkHigh: "220.10",
      fiftyTwoWkLow: "145.25",
      name: "Apple Inc."
    });

    expect(parsed).toMatchObject({
      price: 205.5,
      bid: 205.4,
      ask: 205.6,
      intradayChangePct: 1.13,
      volume: 1500000,
      peRatio: 36.05,
      eps: 8.27,
      pbRatio: 41.05,
      dividendYield: 0.36,
      fiftyTwoWeekHigh: 220.1,
      fiftyTwoWeekLow: 145.25,
      companyName: "Apple Inc."
    });
    expect(parsed).not.toHaveProperty("brokerOrderId");
  });

  it("mock provider returns fallback data for unknown tickers", async () => {
    const enriched = await mockEnrichmentProvider.enrich(["XYZUNK"]);
    expect(enriched.XYZUNK).toBeDefined();
    expect(enriched.XYZUNK?.sector).toBeTruthy();
    expect(enriched.XYZUNK?.peRatio).toBeGreaterThan(0);
    expect(enriched.XYZUNK?.analystRating).toBeTruthy();
  });

  it("noopProvider alias points to the mock provider", async () => {
    // noopProvider is now an alias for mockEnrichmentProvider.
    expect(noopProvider).toBe(mockEnrichmentProvider);
    expect(noopProvider.configured).toBe(true);
    const result = await noopProvider.enrich(["AAPL"]);
    expect(result.AAPL?.sector).toBe("Technology");
  });
});

describe("apiKeyFingerprint", () => {
  it("uses edge-safe SHA-256 without exposing the credential", async () => {
    expect(await apiKeyFingerprint("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("scoreHeadlines", () => {
  it("returns neutral 50 with no headlines or no signal words", () => {
    expect(scoreHeadlines([])).toBe(50);
    expect(scoreHeadlines(["Company holds annual meeting"])).toBe(50);
  });

  it("scores positive headlines above 50 and negative below 50", () => {
    expect(scoreHeadlines(["Stock surges as company beats earnings and raises guidance"])).toBeGreaterThan(50);
    expect(scoreHeadlines(["Shares plunge on downgrade and profit warning"])).toBeLessThan(50);
  });

  it("does not saturate at 100 even with many positive words", () => {
    const score = scoreHeadlines([
      "surge surge surge beats beats record growth gains rally jumps outperform"
    ]);
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(95); // damped + clamped, never a hard 100
  });
});

describe("analyst scoring helpers", () => {
  it("maps rating distributions to a 0–100 score", () => {
    expect(analystScoreFromCounts({ strongBuy: 10, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBe(100);
    expect(analystScoreFromCounts({ strongBuy: 0, buy: 0, hold: 10, sell: 0, strongSell: 0 })).toBe(50);
    expect(analystScoreFromCounts({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 10 })).toBe(0);
    expect(analystScoreFromCounts({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBeUndefined();
  });

  it("maps a 1–5 analyst mean to a 0–100 score", () => {
    expect(analystScoreFromMean(1)).toBe(100); // strong buy
    expect(analystScoreFromMean(3)).toBe(50); // hold
    expect(analystScoreFromMean(5)).toBe(0); // strong sell
  });

  it("labels scores on the Strong Buy … Strong Sell scale", () => {
    expect(labelFromAnalystScore(95)).toBe("Strong Buy");
    expect(labelFromAnalystScore(70)).toBe("Buy");
    expect(labelFromAnalystScore(50)).toBe("Hold");
    expect(labelFromAnalystScore(30)).toBe("Sell");
    expect(labelFromAnalystScore(10)).toBe("Strong Sell");
  });
});

describe("isTransientError", () => {
  it("detects transient errors correctly", () => {
    expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
    expect(isTransientError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientError(new Error("timeout of 5000ms exceeded"))).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError(new Error("failed to fetch"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("HTTP 504 Gateway Timeout"))).toBe(true);
    expect(isTransientError(new Error("database error"))).toBe(false);
    expect(isTransientError(new Error("HTTP 404 Not Found"))).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ── Consent-gated enrichment cache ─────────────────────────────────────────────
// Verifies that data pulled with a user's own stored API key is:
//   - NOT visible to a different non-consenting user (private scope)
//   - IS shared via the pool to a consenting user (pool scope)
//   - env-keyed data remains globally shared (shared scope) as before
//
// This mirrors the exact same privacy contract implemented in src/lib/history.ts.
describe("enrichment cache consent gate", () => {
  // Each test needs a fresh cache + db so key/consent state doesn't bleed.
  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY;
  });

  it("user-keyed data is private: invisible to a non-consenting second user", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { upsertUserApiKey, setDataPoolConsent } = await import("../src/lib/db");
    clearEnrichmentCache();

    const userA = `cg-priv-a-${randomUUID()}`;
    const userB = `cg-priv-b-${randomUUID()}`;
    // Unset users no longer silently share.  Explicit decline keeps user-keyed writes private.
    setDataPoolConsent(userA, false);
    setDataPoolConsent(userB, false);
    // userA has their own API key; userB does NOT have an API key
    upsertUserApiKey(userA, "finnhub", "user-a-finnhub-key");

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      // Return a minimal success: profile2 gives companyName, everything else empty
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Acme Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA fetches — source is "user", no consent → scope = "private"
    const providerA = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userA);
    const resA = await providerA.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(resA.AAPL?.companyName).toBe("Acme Corp");
    expect(fetchCount).toBe(5); // 5 Finnhub sub-calls (news, quote, rec, profile2, metric)

    // userB (no consent) tries with their own env-keyed provider — should NOT see userA's cache
    // To isolate the cache check, we make fetch throw so any cache miss would propagate as empty
    vi.stubGlobal("fetch", async () => { throw new Error("no network"); });
    const providerB = new FinnhubEnrichmentProvider("some-env-key", "env", userB);
    const resB = await providerB.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    // env-key provider reads shared scope — userA's private entry is not visible there
    expect(resB.AAPL?.companyName).toBeUndefined();
  });

  it("TwelveData caps a call to the free-tier credit budget and defers the rest (no 120-symbol 429 burst)", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();
    const prevBudget = process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "8";

    const queriedSymbolCounts: number[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      queriedSymbolCounts.push(syms.length);
      const body: Record<string, unknown> = {};
      for (const s of syms) body[s] = { symbol: s, close: "100", volume: "1000" };
      return new Response(JSON.stringify(body));
    });

    const symbols = Array.from({ length: 20 }, (_, i) => `SYM${i}`);
    const provider = new TwelveDataEnrichmentProvider(`env-key-${randomUUID()}`, "env");
    const res = await provider.enrich(symbols);

    // Exactly ONE call, carrying at most the credit budget (8) symbols — never the full 20 (which
    // would cost 20 credits at once and 429 on the 8-credit/min free tier).
    expect(queriedSymbolCounts).toHaveLength(1);
    expect(queriedSymbolCounts[0]).toBeLessThanOrEqual(8);
    // Every input symbol still appears in the result: queried ones enriched, deferred ones best-effort {}.
    for (const s of symbols) expect(res[s]).toBeDefined();
    expect(res.SYM0?.price).toBe(100); // a queried (highest-priority) symbol got real data

    if (prevBudget === undefined) delete process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    else process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = prevBudget;
  });

  it("TwelveData quota is SHARED per-credential across scans in the same window (2nd scan gets the remainder)", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();
    const prev = process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "2"; // exactly 2 credits/min

    let fetchCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls++;
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      const body: Record<string, unknown> = {};
      for (const s of syms) body[s] = { symbol: s, close: "50" };
      return new Response(JSON.stringify(body));
    });

    // Two accounts sharing the SAME operator key scan inside the same minute. The FIRST spends the
    // whole 2-credit budget; the SECOND gets 0 and returns best-effort immediately (no network call,
    // no stall/queue) — the per-minute limit is respected across concurrent-account scans.
    const sharedKey = `env-key-${randomUUID()}`;
    const a = new TwelveDataEnrichmentProvider(sharedKey, "env", `u-${randomUUID()}`);
    const b = new TwelveDataEnrichmentProvider(sharedKey, "env", `u-${randomUUID()}`);
    const resA = await a.enrich(["AAA", "BBB"]);
    const resB = await b.enrich(["CCC", "DDD"]);

    expect(fetchCalls).toBe(1); // second scan had no budget left → skipped the network entirely
    expect(resA.AAA?.price).toBe(50); // first scan got real data
    expect(resB.CCC).toEqual({}); // second scan deferred (best-effort empty), not a hang
    expect(resB.DDD).toEqual({});

    if (prev === undefined) delete process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    else process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = prev;
  });

  it("TwelveData window is PER-CREDENTIAL: a different key is not gated by another key's window", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();

    let fetchCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls++;
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      const body: Record<string, unknown> = {};
      for (const s of syms) body[s] = { symbol: s, close: "77" };
      return new Response(JSON.stringify(body));
    });

    // Two DIFFERENT keys (e.g. a per-user stored key vs the operator env key) have independent
    // upstream quotas, so the second must NOT be gated by the first's window — both call.
    const a = new TwelveDataEnrichmentProvider(`key-a-${randomUUID()}`, "env");
    const b = new TwelveDataEnrichmentProvider(`key-b-${randomUUID()}`, "user", `u-${randomUUID()}`);
    const resA = await a.enrich(["AAA"]);
    const resB = await b.enrich(["BBB"]);

    expect(fetchCalls).toBe(2); // independent credential lanes each got their call
    expect(resA.AAA?.price).toBe(77);
    expect(resB.BBB?.price).toBe(77);
  });

  it("TwelveData negative-caches a no-data symbol so it rotates out of misses (doesn't starve others)", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();

    const queried: string[][] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      queried.push(syms);
      const body: Record<string, unknown> = {};
      // NODATA returns an error row (no usable fields); the others return a real quote.
      for (const s of syms) body[s] = s === "NODATA" ? { code: 400, status: "error", message: "no data" } : { symbol: s, close: "10" };
      return new Response(JSON.stringify(body));
    });

    const key = `env-key-${randomUUID()}`;
    // Budget of 1 symbol/call so NODATA (front of misses) would otherwise be queried every scan.
    const prevBudget = process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "1";

    const p1 = new TwelveDataEnrichmentProvider(key, "env");
    await p1.enrich(["NODATA", "GOOD"]); // scan 1 queries NODATA (front), gets error → negative-cached
    __resetTwelveDataWindowForTests(); // simulate the credit window elapsing before the next scan
    const p2 = new TwelveDataEnrichmentProvider(key, "env");
    await p2.enrich(["NODATA", "GOOD"]); // scan 2: NODATA is negative-cached (a hit), so GOOD gets the budget

    expect(queried[0]).toEqual(["NODATA"]); // scan 1 spent its 1-symbol budget on the front symbol
    expect(queried[1]).toEqual(["GOOD"]);   // scan 2 rotated past the negative-cached NODATA to GOOD

    if (prevBudget === undefined) delete process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    else process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = prevBudget;
  });

  it("TwelveData does NOT negative-cache a transient per-symbol error (429), only a permanent one (404)", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();

    let queried: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      queried = syms;
      const body: Record<string, unknown> = {};
      for (const s of syms) {
        if (s === "RATELIMITED") body[s] = { code: 429, status: "error", message: "out of API credits" };
        else if (s === "NOTFOUND") body[s] = { code: 404, status: "error", message: "symbol not found" };
        else body[s] = { symbol: s, close: "10" };
      }
      return new Response(JSON.stringify(body));
    });

    const key = `env-key-${randomUUID()}`;
    // Budget of 1 symbol/call isolates each symbol's own scan so re-query behavior is unambiguous.
    const prevBudget = process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = "1";

    // RATELIMITED (transient 429): must NOT be negative-cached, so it's still a miss — and gets
    // re-queried — on the very next scan once the credit window elapses.
    const p1 = new TwelveDataEnrichmentProvider(key, "env");
    const res1 = await p1.enrich(["RATELIMITED"]);
    expect(res1.RATELIMITED).toEqual({});
    __resetTwelveDataWindowForTests();
    const p2 = new TwelveDataEnrichmentProvider(key, "env");
    await p2.enrich(["RATELIMITED"]);
    expect(queried).toEqual(["RATELIMITED"]); // scan 2 re-queried it, not suppressed by a negative cache

    // NOTFOUND (permanent 404): IS negative-cached, so a later scan rotates past it to GOOD instead
    // of re-querying the still-dead symbol.
    __resetTwelveDataWindowForTests();
    const p3 = new TwelveDataEnrichmentProvider(key, "env");
    await p3.enrich(["NOTFOUND", "GOOD"]);
    expect(queried).toEqual(["NOTFOUND"]); // scan 3 spent its 1-symbol budget on the front symbol
    __resetTwelveDataWindowForTests();
    const p4 = new TwelveDataEnrichmentProvider(key, "env");
    await p4.enrich(["NOTFOUND", "GOOD"]);
    expect(queried).toEqual(["GOOD"]); // scan 4 rotated past the negative-cached NOTFOUND to GOOD

    if (prevBudget === undefined) delete process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    else process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN = prevBudget;
  });

  it("TwelveData logs an ok:false health row when a batch is ALL embedded-transient errors (no usable data)", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();

    vi.stubGlobal("fetch", async (url: string) => {
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      const body: Record<string, unknown> = {};
      // Every queried symbol comes back as an embedded transient error (429/5xx) inside HTTP 200 —
      // e.g. a mis-sized credit budget or an upstream outage, not "no data for this symbol".
      for (const s of syms) body[s] = { code: 429, status: "error", message: "out of API credits" };
      return new Response(JSON.stringify(body));
    });

    const key = `env-key-${randomUUID()}`;
    const provider = new TwelveDataEnrichmentProvider(key, "env");
    const beforeCount = getServiceHealthLog("twelvedata", 1000).length;
    const res = await provider.enrich(["RATELIMITED1", "RATELIMITED2"]);
    expect(res.RATELIMITED1).toEqual({});
    expect(res.RATELIMITED2).toEqual({});

    // The whole-request parse still succeeded (HTTP 200, valid JSON), but every symbol failed —
    // this must surface as an ok:false health row so the circuit breaker can see the bad lane,
    // not stay silently healthy while retrying it every window.
    const rows = getServiceHealthLog("twelvedata", 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.ok === 0)).toBe(true);
    const failure = rows.find((r) => r.ok === 0);
    expect(failure?.error_text).toContain("transient");

    // Exactly ONE health row for this call, and it's the failure — NOT an ok:true (outer HTTP/JSON
    // success) paired with an ok:false (all-transient) for the same batch. getLaneHealth's circuit
    // breaker trips only when the last 5 rows are ALL failures; pairing success+failure per batch
    // would make repeated all-transient batches alternate forever and never trip it.
    const afterCount = getServiceHealthLog("twelvedata", 1000).length;
    expect(afterCount - beforeCount).toBe(1);
    expect(rows[0].ok).toBe(0);
  });

  it("TwelveData stays ok:true on a PARTIAL batch (some symbols usable, some embedded-transient)", async () => {
    const { TwelveDataEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();

    vi.stubGlobal("fetch", async (url: string) => {
      const m = String(url).match(/[?&]symbol=([^&]+)/);
      const syms = m ? decodeURIComponent(m[1]).split(",") : [];
      const body: Record<string, unknown> = {};
      for (const s of syms) {
        body[s] = s === "RATELIMITED" ? { code: 429, status: "error", message: "out of API credits" } : { symbol: s, close: "10" };
      }
      return new Response(JSON.stringify(body));
    });

    const key = `env-key-${randomUUID()}`;
    const provider = new TwelveDataEnrichmentProvider(key, "env");
    const res = await provider.enrich(["RATELIMITED", "GOOD"]);
    expect(res.RATELIMITED).toEqual({});
    expect(res.GOOD?.price).toBe(10);

    // At least one symbol was usable, so the lane stays healthy — this call's own health row
    // (the most recent one, since the log is ordered ts DESC) must be ok:true, not ok:false.
    // (Older rows from earlier tests in this file may still be present in the shared log, so
    // don't assert over the whole log — just the row this call just wrote.)
    const rows = getServiceHealthLog("twelvedata", 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].ok).toBe(1);
  });

  it("Tiingo budgets a scan to its hourly cap (3 requests/symbol) regardless of scan size", async () => {
    const { TiingoEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();
    const prev = process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    // 6 requests/hour ÷ 3 calls/symbol = 2 symbols may be queried this scan, whatever the scan size.
    process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR = "6";

    const queriedTickers = new Set<string>();
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      const iex = u.match(/\/iex\/([a-z0-9.-]+)/i);
      if (iex) {
        queriedTickers.add(iex[1].toLowerCase());
        return new Response(JSON.stringify([{ tngoLast: 100, prevClose: 99, volume: 1000 }]));
      }
      if (u.includes("/tiingo/daily/")) return new Response(JSON.stringify({ name: "Test Co" }));
      return new Response(JSON.stringify([])); // news
    });

    const symbols = Array.from({ length: 10 }, (_, i) => `TSYM${i}`);
    const provider = new TiingoEnrichmentProvider(`env-key-${randomUUID()}`, "env");
    const res = await provider.enrich(symbols);

    // Only 2 symbols (6 requests) hit the network; the hourly cap held despite 10 candidates.
    expect(queriedTickers.size).toBe(2);
    expect(queriedTickers.has("tsym0")).toBe(true); // best-first: the top-ranked symbols get the budget
    // Every candidate is still represented — queried ones enriched, deferred ones best-effort {}.
    for (const s of symbols) expect(res[s]).toBeDefined();
    expect(res.TSYM0?.price).toBe(100);

    if (prev === undefined) delete process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    else process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR = prev;
  });

  it("TIINGO_DROP_NEWS shrinks the per-symbol cost to 2, letting more symbols fit the hourly cap", async () => {
    const { TiingoEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();
    const prevQuota = process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    const prevDrop = process.env.TIINGO_DROP_NEWS;
    process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR = "6";
    process.env.TIINGO_DROP_NEWS = "1"; // 2 calls/symbol → 6 ÷ 2 = 3 symbols fit

    const queriedTickers = new Set<string>();
    let newsCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("/tiingo/news")) { newsCalls++; return new Response(JSON.stringify([])); }
      const iex = u.match(/\/iex\/([a-z0-9.-]+)/i);
      if (iex) { queriedTickers.add(iex[1].toLowerCase()); return new Response(JSON.stringify([{ tngoLast: 100, prevClose: 99 }])); }
      return new Response(JSON.stringify({ name: "Test Co" })); // daily
    });

    const symbols = Array.from({ length: 10 }, (_, i) => `NSYM${i}`);
    const provider = new TiingoEnrichmentProvider(`env-key-${randomUUID()}`, "env");
    await provider.enrich(symbols);

    expect(queriedTickers.size).toBe(3); // dropping news freed budget for a 3rd symbol
    expect(newsCalls).toBe(0);           // the news sub-call is never issued when dropped

    if (prevQuota === undefined) delete process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    else process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR = prevQuota;
    if (prevDrop === undefined) delete process.env.TIINGO_DROP_NEWS;
    else process.env.TIINGO_DROP_NEWS = prevDrop;
  });

  it("Tiingo does NOT negative-cache a symbol whose sub-calls ALL failed (403 cred/plan), so it re-queries", async () => {
    const { TiingoEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();

    let attempts = 0;
    vi.stubGlobal("fetch", async () => { attempts++; return new Response("Forbidden", { status: 403 }); });

    const key = `env-key-${randomUUID()}`;
    const p1 = new TiingoEnrichmentProvider(key, "env");
    const r1 = await p1.enrich(["AAA"]);
    expect(r1.AAA).toEqual({});          // all sub-calls 403'd → best-effort empty
    const attemptsAfterFirst = attempts;
    expect(attemptsAfterFirst).toBeGreaterThan(0);

    __resetTwelveDataWindowForTests(); // window elapses; the credential/plan issue is unrelated to the cache
    const p2 = new TiingoEnrichmentProvider(key, "env");
    await p2.enrich(["AAA"]);
    // A negative cache would have suppressed AAA for the TTL; instead scan 2 re-queries it (attempts grew).
    expect(attempts).toBeGreaterThan(attemptsAfterFirst);
  });

  it("Tiingo namespaces its cache by TIINGO_DROP_NEWS so toggling the flag doesn't serve a no-news row", async () => {
    const { TiingoEnrichmentProvider, clearEnrichmentCache, __resetTwelveDataWindowForTests } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    __resetTwelveDataWindowForTests();
    const prevDrop = process.env.TIINGO_DROP_NEWS;

    let newsCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("/tiingo/news")) { newsCalls++; return new Response(JSON.stringify([{ title: "Big news for AAA" }])); }
      if (u.match(/\/iex\//i)) return new Response(JSON.stringify([{ tngoLast: 100, prevClose: 99 }]));
      return new Response(JSON.stringify({ name: "Alpha Co" })); // daily
    });

    const key = `env-key-${randomUUID()}`;
    // Scan 1 with news DROPPED → caches a row with no headlines under the "tiingo-nonews" namespace.
    process.env.TIINGO_DROP_NEWS = "1";
    const withoutNews = await new TiingoEnrichmentProvider(key, "env").enrich(["AAA"]);
    expect(withoutNews.AAA?.headlines).toBeUndefined();
    expect(newsCalls).toBe(0);

    // Scan 2 with news ENABLED must NOT be served the cached no-news row — it re-queries and gets headlines.
    __resetTwelveDataWindowForTests();
    delete process.env.TIINGO_DROP_NEWS;
    const withNews = await new TiingoEnrichmentProvider(key, "env").enrich(["AAA"]);
    expect(newsCalls).toBe(1);                       // the news endpoint WAS hit (not a stale cache hit)
    expect(withNews.AAA?.headlines).toEqual(["Big news for AAA"]);

    if (prevDrop === undefined) delete process.env.TIINGO_DROP_NEWS;
    else process.env.TIINGO_DROP_NEWS = prevDrop;
  });

  it("FINNHUB_DROP_RECOMMENDATION drops the recommendation sub-call (5→4) without fabricating analyst data", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const originalFlag = process.env.FINNHUB_DROP_RECOMMENDATION;

    const runAndCount = async () => {
      clearEnrichmentCache();
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        urls.push(String(url));
        if (String(url).includes("profile2")) return new Response(JSON.stringify({ name: "Acme Corp" }));
        if (String(url).includes("recommendation")) {
          return new Response(JSON.stringify([{ strongBuy: 5, buy: 3, hold: 1, sell: 0, strongSell: 0 }]));
        }
        return new Response(JSON.stringify({}));
      });
      const provider = new FinnhubEnrichmentProvider(`env-key-${randomUUID()}`, "env");
      const res = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
      return { urls, res };
    };

    // Flag OFF (default) → 5 calls, recommendation IS fetched and yields an analyst score.
    delete process.env.FINNHUB_DROP_RECOMMENDATION;
    const off = await runAndCount();
    expect(off.urls.length).toBe(5);
    expect(off.urls.some((u) => u.includes("recommendation"))).toBe(true);
    expect(off.res.AAPL?.analystBySource?.finnhub?.score).toBeGreaterThan(0);

    // Flag ON → 4 calls, recommendation NOT fetched, no fabricated Finnhub analyst rating.
    process.env.FINNHUB_DROP_RECOMMENDATION = "1";
    const on = await runAndCount();
    expect(on.urls.length).toBe(4);
    expect(on.urls.some((u) => u.includes("recommendation"))).toBe(false);
    expect(on.res.AAPL?.analystBySource?.finnhub).toBeUndefined();
    // Non-analyst fields still populate from the remaining calls.
    expect(on.res.AAPL?.companyName).toBe("Acme Corp");

    if (originalFlag !== undefined) process.env.FINNHUB_DROP_RECOMMENDATION = originalFlag;
    else delete process.env.FINNHUB_DROP_RECOMMENDATION;
  });

  it("keys the Finnhub cache by FINNHUB_DROP_RECOMMENDATION so flipping the flag refetches (not a stale no-rec row)", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    const originalFlag = process.env.FINNHUB_DROP_RECOMMENDATION;

    let recFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("recommendation")) {
        recFetches++;
        return new Response(JSON.stringify([{ strongBuy: 5, buy: 3, hold: 1, sell: 0, strongSell: 0 }]));
      }
      if (String(url).includes("profile2")) return new Response(JSON.stringify({ name: "Acme Corp" }));
      return new Response(JSON.stringify({}));
    });

    try {
      // Flag ON: recommendation dropped, row cached under the flag-specific namespace.
      process.env.FINNHUB_DROP_RECOMMENDATION = "1";
      const onProvider = new FinnhubEnrichmentProvider("env-key", "env");
      const on1 = await onProvider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
      expect(on1.AAPL?.analystBySource?.finnhub).toBeUndefined();
      expect(recFetches).toBe(0);
      // Same flag again → cache hit, still no recommendation fetch.
      await onProvider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
      expect(recFetches).toBe(0);

      // Flag OFF: distinct cache namespace → MISS → refetch, now including the recommendation, so the
      // blended analyst rating regains Finnhub's vote instead of serving the stale no-rec row until TTL.
      delete process.env.FINNHUB_DROP_RECOMMENDATION;
      const offProvider = new FinnhubEnrichmentProvider("env-key", "env");
      const off1 = await offProvider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
      expect(recFetches).toBe(1);
      expect(off1.AAPL?.analystBySource?.finnhub?.score).toBeGreaterThan(0);
    } finally {
      if (originalFlag !== undefined) process.env.FINNHUB_DROP_RECOMMENDATION = originalFlag;
      else delete process.env.FINNHUB_DROP_RECOMMENDATION;
    }
  });

  it("user-keyed data is shared via pool to a consenting second user", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { upsertUserApiKey, setDataPoolConsent } = await import("../src/lib/db");
    clearEnrichmentCache();

    const userA = `cg-pool-a-${randomUUID()}`;
    const userB = `cg-pool-b-${randomUUID()}`;
    // Both users consent to the data pool
    upsertUserApiKey(userA, "finnhub", "user-a-finnhub-key");
    setDataPoolConsent(userA, true);
    setDataPoolConsent(userB, true);

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Pool Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA fetches — user-key + consent → scope = "pool"
    const providerA = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userA);
    const resA = await providerA.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(resA.AAPL?.companyName).toBe("Pool Corp");
    expect(fetchCount).toBe(5);

    // userB (consenting) reads from the pool — no fetch should be needed
    const providerB = new FinnhubEnrichmentProvider("user-b-finnhub-key", "user", userB);
    const resB = await providerB.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(resB.AAPL?.companyName).toBe("Pool Corp");
    // Pool hit — no additional fetch calls
    expect(fetchCount).toBe(5);
  });

  it("env-keyed data remains globally shared regardless of user or consent", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const userA = `cg-env-a-${randomUUID()}`;
    const userB = `cg-env-b-${randomUUID()}`;

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Env Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA uses env key — source = "env" → always shared scope
    const providerA = new FinnhubEnrichmentProvider("env-finnhub-key", "env", userA);
    await providerA.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(fetchCount).toBe(5);

    // userB (no consent) uses env key — should hit the shared cache, no new fetch
    const providerB = new FinnhubEnrichmentProvider("env-finnhub-key", "env", userB);
    const resB = await providerB.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(resB.AAPL?.companyName).toBe("Env Corp");
    expect(fetchCount).toBe(5); // shared cache hit — no additional fetches
  });

  it("MARKET_DATA_SHARE_USER_KEYED_HISTORY=on promotes user-key data to shared scope", async () => {
    process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY = "on";
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const userA = `cg-share-a-${randomUUID()}`;
    const userB = `cg-share-b-${randomUUID()}`;

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Share Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA's user-key → forced to shared because of the env override
    const providerA = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userA);
    await providerA.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(fetchCount).toBe(5);

    // userB (no consent, no user key) can read from shared scope
    const providerB = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userB);
    const resB = await providerB.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(resB.AAPL?.companyName).toBe("Share Corp");
    expect(fetchCount).toBe(5); // shared cache hit
  });
});

describe("Finnhub Cache Poisoning Protection", () => {
  it("prevents cache writes on Finnhub when a transient error occurs", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (url.includes("quote")) {
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res1.AAPL).toEqual({});
    expect(fetchCount).toBe(6);

    const res2 = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res2.AAPL).toEqual({});
    expect(fetchCount).toBe(12);
  });

  it("caches normally on Finnhub when all queries succeed", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (url.includes("profile2")) {
        return new Response(JSON.stringify({ name: "Apple" }));
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res1.AAPL).toEqual({ companyName: "Apple" });
    expect(fetchCount).toBe(5);

    const res2 = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res2.AAPL).toEqual({ companyName: "Apple" });
    expect(fetchCount).toBe(5);
  });
});

// NEWS_RELEVANCE_FILTER / NEWS_RELEVANCE_MIN_SCORE gating of Finnhub's /company-news headlines.
// Finnhub's endpoint is already scoped to the symbol server-side but carries no native per-
// headline relevance score, so this applies news-relevance.ts's headline-text rubric directly —
// see the section comment above newsRelevanceFilterEnabled (data-providers.ts).
describe("Finnhub company-news relevance gating", () => {
  const originalFilter = process.env.NEWS_RELEVANCE_FILTER;
  const originalMinScore = process.env.NEWS_RELEVANCE_MIN_SCORE;

  beforeEach(() => {
    delete process.env.NEWS_RELEVANCE_FILTER;
    delete process.env.NEWS_RELEVANCE_MIN_SCORE;
  });

  afterEach(() => {
    if (originalFilter) process.env.NEWS_RELEVANCE_FILTER = originalFilter;
    else delete process.env.NEWS_RELEVANCE_FILTER;
    if (originalMinScore) process.env.NEWS_RELEVANCE_MIN_SCORE = originalMinScore;
    else delete process.env.NEWS_RELEVANCE_MIN_SCORE;
  });

  it("with the filter ON (default), drops an irrelevant headline that mentions neither the ticker nor the company name", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("profile2")) return new Response(JSON.stringify({ name: "Apple Inc." }));
      if (url.includes("company-news")) {
        return new Response(JSON.stringify([
          { headline: "AAPL reports record quarterly revenue" },
          { headline: "Regional bakery chain opens new downtown location" }
        ]));
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res.AAPL?.headlines).toEqual(["AAPL reports record quarterly revenue"]);
  });

  it("with the filter OFF, keeps every headline Finnhub returned (pre-filter byte-identical behavior)", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.NEWS_RELEVANCE_FILTER = "0";

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("profile2")) return new Response(JSON.stringify({ name: "Apple Inc." }));
      if (url.includes("company-news")) {
        return new Response(JSON.stringify([
          { headline: "AAPL reports record quarterly revenue" },
          { headline: "Regional bakery chain opens new downtown location" }
        ]));
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res.AAPL?.headlines).toEqual([
      "AAPL reports record quarterly revenue",
      "Regional bakery chain opens new downtown location"
    ]);
  });

  it("an ambiguous company name (Apple) with no finance-event term is dropped even though Finnhub scoped the article to this symbol", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("profile2")) return new Response(JSON.stringify({ name: "Apple Inc." }));
      if (url.includes("company-news")) {
        return new Response(JSON.stringify([
          { headline: "She picked up an apple from the fruit stand on her walk" }
        ]));
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"], skipDaysToEarningsCalendar("AAPL"));
    expect(res.AAPL?.headlines).toBeUndefined(); // zero surviving headlines -> no coverage, never fabricated
  });
});

describe("Finnhub /calendar/earnings — daysToEarnings fallback (2026-08-02)", () => {
  // Real sample response shape from Finnhub's own docs schema (finnhub.io/docs/api/earnings-calendar,
  // pulled 2026-08-02 via the page's embedded `window.docSchema` — no key needed to read the schema
  // itself). Field names (symbol/date/hour/quarter/year/epsActual/epsEstimate/revenueActual/
  // revenueEstimate) are Finnhub's own documented EarningRelease definition, not guessed.
  const REAL_SAMPLE = {
    earningsCalendar: [
      {
        date: "2020-01-28",
        epsActual: 4.99,
        epsEstimate: 4.5474,
        hour: "amc",
        quarter: 1,
        revenueActual: 91819000000,
        revenueEstimate: 88496400810,
        symbol: "AAPL",
        year: 2020
      },
      {
        date: "2019-10-30",
        epsActual: 3.03,
        epsEstimate: 2.8393,
        hour: "amc",
        quarter: 4,
        revenueActual: 64040000000,
        revenueEstimate: 63032500000,
        symbol: "AAPL",
        year: 2019
      }
    ]
  };

  describe("looksLikeFinnhubEarningsCalendar / parseFinnhubEarningsCalendar", () => {
    it("recognizes the documented { earningsCalendar: [...] } shape, including an empty array (a quiet reporting window, not an error)", async () => {
      const { looksLikeFinnhubEarningsCalendar } = await import("../src/lib/data-providers");
      expect(looksLikeFinnhubEarningsCalendar(REAL_SAMPLE)).toBe(true);
      expect(looksLikeFinnhubEarningsCalendar({ earningsCalendar: [] })).toBe(true);
      expect(looksLikeFinnhubEarningsCalendar({})).toBe(false);
      expect(looksLikeFinnhubEarningsCalendar([])).toBe(false);
      expect(looksLikeFinnhubEarningsCalendar(null)).toBe(false);
      expect(looksLikeFinnhubEarningsCalendar("error")).toBe(false);
    });

    it("parses symbol -> earliest report date from a real sample response", async () => {
      const { parseFinnhubEarningsCalendar } = await import("../src/lib/data-providers");
      const bySymbol = parseFinnhubEarningsCalendar(REAL_SAMPLE);
      // AAPL appears twice (two historical quarters) — keeps the EARLIEST reportDate.
      expect(bySymbol.size).toBe(1);
      expect(bySymbol.get("AAPL")).toBe(Date.parse("2019-10-30T00:00:00Z"));
    });

    it("keeps the EARLIEST date when a symbol appears more than once, regardless of row order", async () => {
      const { parseFinnhubEarningsCalendar } = await import("../src/lib/data-providers");
      const bySymbol = parseFinnhubEarningsCalendar({
        earningsCalendar: [
          { symbol: "MSFT", date: "2026-11-01" },
          { symbol: "MSFT", date: "2026-08-05" }
        ]
      });
      expect(bySymbol.get("MSFT")).toBe(Date.parse("2026-08-05T00:00:00Z"));
    });

    it("returns an empty map (never throws, never guesses) for malformed/unexpected shapes", async () => {
      const { parseFinnhubEarningsCalendar } = await import("../src/lib/data-providers");
      expect(parseFinnhubEarningsCalendar({}).size).toBe(0);
      expect(parseFinnhubEarningsCalendar({ error: "Please use an API key." }).size).toBe(0);
      expect(parseFinnhubEarningsCalendar(null).size).toBe(0);
      expect(parseFinnhubEarningsCalendar({ earningsCalendar: [{ symbol: "BAD" }] }).size).toBe(0); // no date
      expect(parseFinnhubEarningsCalendar({ earningsCalendar: [{ date: "2026-08-05" }] }).size).toBe(0); // no symbol
    });
  });

  describe("enrich() integration", () => {
    /** UTC calendar-date string exactly `daysFromToday` days from "now"'s UTC midnight — matches
     *  alphaVantageDaysToEarnings' own truncation (shared by this fallback's day-math), so the
     *  expected day count is exact regardless of what wall-clock time the test happens to run at. */
    function utcDateString(daysFromToday: number): string {
      const truncatedToday = Math.floor(Date.now() / 86_400_000) * 86_400_000;
      return new Date(truncatedToday + daysFromToday * 86_400_000).toISOString().slice(0, 10);
    }

    it("fetches the market-wide calendar ONCE (no symbol= param) and fills daysToEarnings for a miss", async () => {
      const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      const reportDate = utcDateString(12);
      let calendarUrl: string | undefined;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("/calendar/earnings")) {
          calendarUrl = u;
          return new Response(JSON.stringify({ earningsCalendar: [{ symbol: "AAPL", date: reportDate }] }));
        }
        if (u.includes("profile2")) return new Response(JSON.stringify({ name: "Apple Inc." }));
        return new Response(JSON.stringify({}));
      });

      const provider = new FinnhubEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL"]);
      expect(res.AAPL?.daysToEarnings).toBe(12);
      expect(res.AAPL?.companyName).toBe("Apple Inc."); // the rest of the row still populates alongside it
      expect(calendarUrl).toBeDefined();
      expect(calendarUrl).toContain("/calendar/earnings");
      expect(calendarUrl).not.toContain("symbol=");
    });

    it("dispatches only ONE calendar call for a multi-symbol batch, filling every matched symbol from it", async () => {
      const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      const aaplDate = utcDateString(3);
      const msftDate = utcDateString(9);
      let calendarCalls = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("/calendar/earnings")) {
          calendarCalls++;
          return new Response(JSON.stringify({
            earningsCalendar: [
              { symbol: "AAPL", date: aaplDate },
              { symbol: "MSFT", date: msftDate }
            ]
          }));
        }
        return new Response(JSON.stringify({}));
      });

      const provider = new FinnhubEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL", "MSFT"]);
      expect(res.AAPL?.daysToEarnings).toBe(3);
      expect(res.MSFT?.daysToEarnings).toBe(9);
      expect(calendarCalls).toBe(1); // ONE market-wide pull, not one per symbol
    });

    it("skips the calendar fetch entirely when the coveredFields hint already marks daysToEarnings covered", async () => {
      const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      let calendarCalls = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("/calendar/earnings")) {
          calendarCalls++;
          throw new Error("must not be called — daysToEarnings was already covered upstream");
        }
        return new Response(JSON.stringify({}));
      });

      const provider = new FinnhubEnrichmentProvider("test-key");
      const context: EnrichmentContext = { coveredFields: { AAPL: new Set(["daysToEarnings"]) } };
      const res = await provider.enrich(["AAPL"], context);
      expect(res.AAPL?.daysToEarnings).toBeUndefined(); // Finnhub added nothing — the hint source owns it
      expect(calendarCalls).toBe(0);
    });

    it("a malformed/unusable calendar response never fabricates daysToEarnings and never crashes enrich()", async () => {
      const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("/calendar/earnings")) {
          // Not the documented shape at all (e.g. an unrelated error page).
          return new Response(JSON.stringify({ error: "unexpected upstream failure" }));
        }
        if (u.includes("profile2")) return new Response(JSON.stringify({ name: "Apple Inc." }));
        return new Response(JSON.stringify({}));
      });

      const provider = new FinnhubEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL"]);
      expect(res.AAPL?.daysToEarnings).toBeUndefined();
      // The rest of the row's own fields still came through — one field's failure doesn't blank the rest.
      expect(res.AAPL?.companyName).toBe("Apple Inc.");
    });

    it("fills daysToEarnings even for a symbol served from Finnhub's OWN per-symbol row cache (decoupled from that row's TTL)", async () => {
      const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      const reportDate = utcDateString(5);
      let calendarCalls = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("/calendar/earnings")) {
          calendarCalls++;
          return new Response(JSON.stringify({ earningsCalendar: [{ symbol: "AAPL", date: reportDate }] }));
        }
        if (u.includes("profile2")) return new Response(JSON.stringify({ name: "Apple Inc." }));
        return new Response(JSON.stringify({}));
      });

      const provider = new FinnhubEnrichmentProvider("test-key");
      const res1 = await provider.enrich(["AAPL"]);
      expect(res1.AAPL?.daysToEarnings).toBe(5);
      expect(calendarCalls).toBe(1);

      // Second call: the per-symbol Finnhub row (companyName etc.) is now a cache HIT — no new
      // per-symbol network calls — but daysToEarnings still applies fresh from the still-warm
      // shared calendar cache (no second calendar network call either, since it's within TTL).
      const res2 = await provider.enrich(["AAPL"]);
      expect(res2.AAPL?.companyName).toBe("Apple Inc.");
      expect(res2.AAPL?.daysToEarnings).toBe(5);
      expect(calendarCalls).toBe(1); // still just the one cold-cache pull
    });

    it("never fills a past/stale calendar entry (never fabricated)", async () => {
      const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      const pastDate = utcDateString(-10);
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("/calendar/earnings")) {
          return new Response(JSON.stringify({ earningsCalendar: [{ symbol: "AAPL", date: pastDate }] }));
        }
        return new Response(JSON.stringify({}));
      });

      const provider = new FinnhubEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL"]);
      expect(res.AAPL?.daysToEarnings).toBeUndefined();
    });
  });
});

describe("Alpha Vantage Warning Detection", () => {
  // The EARNINGS_CALENDAR fallback (below) reserves from the SAME persisted daily budget/key
  // pool as NEWS_SENTIMENT — reset both before every test in this describe block so usage never
  // silently accumulates across tests sharing this file's one temp DB (mirrors the pattern the
  // reset helpers themselves document — no test here previously needed this because AV had only
  // ONE call shape; now there are two sharing one budget).
  beforeEach(() => {
    __resetAlphaVantageDailyBudgetForTests();
    __resetKeyPoolRegistryForTests();
  });

  it("throws error and does not cache when Alpha Vantage returns HTTP 200 with Note", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let newsSentimentCount = 0;
    let earningsCalendarCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("function=EARNINGS_CALENDAR")) {
        earningsCalendarCount++;
        // Header-only CSV ("no known upcoming earnings this pull") — a benign, valid response so
        // this test stays focused on the NEWS_SENTIMENT Note/warning path; the calendar's OWN
        // warning-detection path has a dedicated test below.
        return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n");
      }
      newsSentimentCount++;
      return new Response(JSON.stringify({
        Note: "Thank you for using Alpha Vantage! Standard rate limit is 25 requests per day..."
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({});
    expect(newsSentimentCount).toBe(1);
    // First enrich() call also triggers the ONE market-wide EARNINGS_CALENDAR pull (cold cache).
    expect(earningsCalendarCount).toBe(1);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({});
    expect(newsSentimentCount).toBe(2); // Note never caches — NEWS_SENTIMENT retried every call
    // Calendar cache is still warm (positive 24h TTL on the valid header-only pull above) — no
    // second market-wide call this run.
    expect(earningsCalendarCount).toBe(1);
  });

  it("caches normally on Alpha Vantage when response has news feed", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let newsSentimentCount = 0;
    let earningsCalendarCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("function=EARNINGS_CALENDAR")) {
        earningsCalendarCount++;
        return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n");
      }
      newsSentimentCount++;
      return new Response(JSON.stringify({
        feed: [
          {
            title: "AAPL is doing great",
            ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.2" }]
          }
        ]
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({ headlines: ["AAPL is doing great"], sentiment: 70 });
    expect(newsSentimentCount).toBe(1);
    expect(earningsCalendarCount).toBe(1); // cold calendar cache on the first call

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({ headlines: ["AAPL is doing great"], sentiment: 70 });
    expect(newsSentimentCount).toBe(1); // NEWS_SENTIMENT cache hit — no re-fetch
    expect(earningsCalendarCount).toBe(1); // calendar cache still warm — no re-fetch
  });

  // Composite review (e): Alpha Vantage's quota/error text has been observed echoing the
  // caller's own API key (e.g. referencing the request URL). That text is stored verbatim in
  // api_health_log and surfaced through connections-health/the ops snapshot — a real secret
  // leak if not scrubbed before logging.
  it("scrubs the caller's own API key out of the warning/error text before it reaches api_health_log", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const secretKey = "SUPER_SECRET_AV_KEY_123";
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({
        Note: `Thank you for using Alpha Vantage! Please visit https://www.alphavantage.co/premium/?apikey=${secretKey} for a higher rate limit.`
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider(secretKey);
    // This single call also triggers the cold-cache EARNINGS_CALENDAR pull (same mock, same
    // Note-shaped response) — both call sites independently scrub the key before logging, which
    // this test verifies across EVERY row it produced, not just the NEWS_SENTIMENT one.
    const res = await provider.enrich(["AAPL"]);
    expect(res.AAPL).toEqual({});

    const rows = getServiceHealthLog("alpha-vantage", 5);
    expect(rows.length).toBeGreaterThan(0);
    const errorTexts = rows.map((r) => r.error_text).filter((t): t is string => typeof t === "string");
    expect(errorTexts.length).toBeGreaterThan(0);
    for (const text of errorTexts) {
      expect(text).not.toContain(secretKey);
    }
    expect(errorTexts.some((t) => t.includes("apikey=***"))).toBe(true);
  });

  describe("suppliesFields", () => {
    it("declares exactly the fields it can supply (sentiment/headlines/daysToEarnings)", async () => {
      const { AlphaVantageEnrichmentProvider } = await import("../src/lib/data-providers");
      const provider = new AlphaVantageEnrichmentProvider("test-key");
      expect(provider.suppliesFields).toEqual(["sentiment", "headlines", "daysToEarnings"]);
    });
  });

  describe("parseAlphaVantageEarningsCalendar / alphaVantageDaysToEarnings — EARNINGS_CALENDAR fallback", () => {
    // Real header + rows from a live 2026-08-02 pull of
    // https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=demo
    // (no `symbol` param — AV's documented market-wide default). BCC's quoted, comma-containing
    // company name is a genuine field from that response, exercising the CSV quote-handling.
    const REAL_CSV_SAMPLE =
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
      "ABTC,AMERICAN BITCOIN CORPORATION,2026-08-03,2026-06-30,,USD,pre-market\n" +
      "ADEA,ADEIA INCORPORATED,2026-08-03,2026-06-30,0.22,USD,post-market\n" +
      "BCC,\"BOISE CASCADE, L.L.C.\",2026-08-03,2026-06-30,1.23,USD,post-market\n";

    it("parses symbol -> reportDate from a real market-wide CSV pull, handling a quoted comma in a company name", async () => {
      const { parseAlphaVantageEarningsCalendar } = await import("../src/lib/data-providers");
      const bySymbol = parseAlphaVantageEarningsCalendar(REAL_CSV_SAMPLE);
      expect(bySymbol.size).toBe(3);
      expect(bySymbol.get("ABTC")).toBe(Date.parse("2026-08-03T00:00:00Z"));
      expect(bySymbol.get("ADEA")).toBe(Date.parse("2026-08-03T00:00:00Z"));
      // BCC's row survives the embedded comma inside its quoted company name — if the parser
      // naively split on every comma, this row's columns would misalign and reportDate would
      // parse as garbage (or the row would be dropped) instead of landing on the correct date.
      expect(bySymbol.get("BCC")).toBe(Date.parse("2026-08-03T00:00:00Z"));
    });

    it("keeps the EARLIEST reportDate when a symbol appears more than once", async () => {
      const { parseAlphaVantageEarningsCalendar } = await import("../src/lib/data-providers");
      const csv =
        "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
        "AAPL,APPLE INC,2026-11-01,2026-09-30,1.50,USD,post-market\n" +
        "AAPL,APPLE INC,2026-08-05,2026-06-30,1.40,USD,post-market\n";
      const bySymbol = parseAlphaVantageEarningsCalendar(csv);
      expect(bySymbol.get("AAPL")).toBe(Date.parse("2026-08-05T00:00:00Z"));
    });

    it("returns an empty map (never throws) for a header-only CSV", async () => {
      const { parseAlphaVantageEarningsCalendar } = await import("../src/lib/data-providers");
      const bySymbol = parseAlphaVantageEarningsCalendar(
        "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n"
      );
      expect(bySymbol.size).toBe(0);
    });

    it("returns an empty map (never guesses) for a non-CSV / quota-message body", async () => {
      const { parseAlphaVantageEarningsCalendar } = await import("../src/lib/data-providers");
      const bySymbol = parseAlphaVantageEarningsCalendar(
        JSON.stringify({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint." })
      );
      expect(bySymbol.size).toBe(0);
    });

    it("looksLikeAlphaVantageEarningsCalendarCsv distinguishes the documented CSV header from anything else", async () => {
      const { looksLikeAlphaVantageEarningsCalendarCsv } = await import("../src/lib/data-providers");
      expect(looksLikeAlphaVantageEarningsCalendarCsv(REAL_CSV_SAMPLE)).toBe(true);
      expect(looksLikeAlphaVantageEarningsCalendarCsv("{\"Note\":\"rate limited\"}")).toBe(false);
      expect(looksLikeAlphaVantageEarningsCalendarCsv("")).toBe(false);
    });

    it("alphaVantageDaysToEarnings computes whole UTC calendar days, clamped and never fabricated for a past date", async () => {
      const { alphaVantageDaysToEarnings } = await import("../src/lib/data-providers");
      const now = Date.parse("2026-08-02T15:30:00Z"); // mid-day, not midnight — must not skew day math
      expect(alphaVantageDaysToEarnings(Date.parse("2026-08-12T00:00:00Z"), now)).toBe(10);
      expect(alphaVantageDaysToEarnings(Date.parse("2026-08-02T00:00:00Z"), now)).toBe(0); // today
      expect(alphaVantageDaysToEarnings(Date.parse("2026-07-30T00:00:00Z"), now)).toBeUndefined(); // past
    });
  });

  describe("EARNINGS_CALENDAR fallback — enrich() integration", () => {
    /** UTC calendar-date string exactly `daysFromToday` days from "now"'s UTC midnight — matches
     *  alphaVantageDaysToEarnings' own truncation, so the expected day count is exact and
     *  deterministic regardless of what wall-clock time the test happens to run at. */
    function utcDateString(daysFromToday: number): string {
      const truncatedToday = Math.floor(Date.now() / 86_400_000) * 86_400_000;
      return new Date(truncatedToday + daysFromToday * 86_400_000).toISOString().slice(0, 10);
    }

    it("fetches the market-wide calendar ONCE (no `symbol=` param) and fills daysToEarnings for a miss, alongside NEWS_SENTIMENT", async () => {
      const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      const reportDate = utcDateString(10);
      let calendarUrl: string | undefined;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("function=EARNINGS_CALENDAR")) {
          calendarUrl = u;
          return new Response(
            "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
              `AAPL,APPLE INC,${reportDate},2026-06-30,1.50,USD,post-market\n`
          );
        }
        return new Response(JSON.stringify({ feed: [] })); // valid, empty NEWS_SENTIMENT feed
      });

      const provider = new AlphaVantageEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL"]);
      expect(res.AAPL?.daysToEarnings).toBe(10);
      expect(calendarUrl).toBeDefined();
      expect(calendarUrl).toContain("function=EARNINGS_CALENDAR");
      expect(calendarUrl).toContain("horizon=3month");
      expect(calendarUrl).not.toContain("symbol=");
    });

    it("dispatches only ONE calendar call for a multi-symbol batch, filling every matched symbol from it", async () => {
      const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      const aaplDate = utcDateString(3);
      const msftDate = utcDateString(7);
      let calendarCalls = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("function=EARNINGS_CALENDAR")) {
          calendarCalls++;
          return new Response(
            "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
              `AAPL,APPLE INC,${aaplDate},2026-06-30,1.50,USD,post-market\n` +
              `MSFT,MICROSOFT CORP,${msftDate},2026-06-30,2.10,USD,post-market\n`
          );
        }
        return new Response(JSON.stringify({ feed: [] }));
      });

      const provider = new AlphaVantageEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL", "MSFT"]);
      expect(res.AAPL?.daysToEarnings).toBe(3);
      expect(res.MSFT?.daysToEarnings).toBe(7);
      expect(calendarCalls).toBe(1); // ONE market-wide pull, not one per symbol
    });

    it("skips the calendar fetch entirely when the free-wave coverage hint already filled daysToEarnings", async () => {
      const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      let calendarCalls = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("function=EARNINGS_CALENDAR")) {
          calendarCalls++;
          throw new Error("must not be called — daysToEarnings was already covered upstream");
        }
        return new Response(JSON.stringify({ feed: [] }));
      });

      const provider = new AlphaVantageEnrichmentProvider("test-key");
      const context: EnrichmentContext = { coveredFields: { AAPL: new Set(["daysToEarnings"]) } };
      const res = await provider.enrich(["AAPL"], context);
      expect(res.AAPL?.daysToEarnings).toBeUndefined(); // AV added nothing — the hint source owns it
      expect(calendarCalls).toBe(0);
    });

    it("a malformed/unusable EARNINGS_CALENDAR response never fabricates daysToEarnings and never crashes enrich()", async () => {
      const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      vi.stubGlobal("fetch", async (url: string) => {
        const u = String(url);
        if (u.includes("function=EARNINGS_CALENDAR")) {
          // Not the documented CSV shape at all (e.g. an unrelated JSON error page).
          return new Response(JSON.stringify({ error: "unexpected upstream failure" }));
        }
        return new Response(JSON.stringify({
          feed: [{ title: "AAPL headline", ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.1" }] }]
        }));
      });

      const provider = new AlphaVantageEnrichmentProvider("test-key");
      const res = await provider.enrich(["AAPL"]);
      expect(res.AAPL?.daysToEarnings).toBeUndefined();
      // NEWS_SENTIMENT's own fields still came through — one field's failure doesn't blank the rest.
      expect(res.AAPL?.sentiment).toBeDefined();
      expect(res.AAPL?.headlines).toEqual(["AAPL headline"]);
    });
  });

  describe("Fintech Studios / PowerIntell", () => {
    it("adds FintechStudiosEnrichmentProvider to cascade when key is set", async () => {
      process.env.FINTECH_STUDIOS_API_KEY = "test-key-fts";
      migrateLocalEnvCredentials();
      const provider = getEnrichmentProvider();
      expect(provider.name).toContain("fintechstudios");
    });

    it("fetches news and computes sentiment correctly", async () => {
      const { FintechStudiosEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      let fetchCount = 0;
      let requestedUrl = "";
      let requestedBody: any = null;

      vi.stubGlobal("fetch", async (url: string, init: any) => {
        fetchCount++;
        requestedUrl = url;
        requestedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            articles: [
              { title: "Apple surges on new AI model launch" },
              { title: "Caterpillar logs steady growth" } // Wait, this is just mocked search articles
            ]
          }
        }));
      });

      const provider = new FintechStudiosEnrichmentProvider("fts-key");
      const res = await provider.enrich(["AAPL"]);

      expect(fetchCount).toBe(1);
      expect(requestedUrl).toBe("https://studio.fintechstudios.com/api/v1/search");
      expect(requestedBody).toEqual({ query: "AAPL stock", limit: 5 });
      expect(res.AAPL).toEqual({
        headlines: [
          "Apple surges on new AI model launch",
          "Caterpillar logs steady growth"
        ],
        sentiment: 76
      });
      // Verify cache works
      const resCached = await provider.enrich(["AAPL"]);
      expect(fetchCount).toBe(1);
      expect(resCached.AAPL).toEqual(res.AAPL);
    });

    it("prevents cache writes on transient errors", async () => {
      const { FintechStudiosEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      let fetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCount++;
        return new Response("Internal Server Error", { status: 500 });
      });

      const provider = new FintechStudiosEnrichmentProvider("fts-key");
      const res1 = await provider.enrich(["AAPL"]);
      expect(res1.AAPL).toEqual({});
      expect(fetchCount).toBe(1);

      const res2 = await provider.enrich(["AAPL"]);
      expect(res2.AAPL).toEqual({});
      expect(fetchCount).toBe(2);
    });
  });
});

// NEWS_RELEVANCE_FILTER / NEWS_RELEVANCE_MIN_SCORE gating of AV's NEWS_SENTIMENT feed — see the
// section comment above alphaVantageItemIsRelevant (data-providers.ts) for the never-drop-
// unscored-data contract this mirrors from marketaux-provider.ts's match_score gating.
describe("Alpha Vantage NEWS_SENTIMENT relevance gating (relevance_score)", () => {
  const originalFilter = process.env.NEWS_RELEVANCE_FILTER;
  const originalMinScore = process.env.NEWS_RELEVANCE_MIN_SCORE;

  beforeEach(() => {
    __resetAlphaVantageDailyBudgetForTests();
    __resetKeyPoolRegistryForTests();
    delete process.env.NEWS_RELEVANCE_FILTER;
    delete process.env.NEWS_RELEVANCE_MIN_SCORE;
  });

  afterEach(() => {
    if (originalFilter) process.env.NEWS_RELEVANCE_FILTER = originalFilter;
    else delete process.env.NEWS_RELEVANCE_FILTER;
    if (originalMinScore) process.env.NEWS_RELEVANCE_MIN_SCORE = originalMinScore;
    else delete process.env.NEWS_RELEVANCE_MIN_SCORE;
  });

  function feedResponse(items: Array<{ title: string; relevanceScore?: string; sentimentScore?: string }>) {
    return new Response(JSON.stringify({
      feed: items.map((it) => ({
        title: it.title,
        ticker_sentiment: [
          {
            ticker: "AAPL",
            ...(it.sentimentScore !== undefined && { ticker_sentiment_score: it.sentimentScore }),
            ...(it.relevanceScore !== undefined && { relevance_score: it.relevanceScore })
          }
        ]
      }))
    }));
  }

  it("with the filter ON (default), an item below the relevance threshold is dropped from BOTH headlines and the sentiment average", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.NEWS_RELEVANCE_MIN_SCORE = "0.35";

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("function=EARNINGS_CALENDAR")) {
        return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n");
      }
      return feedResponse([{ title: "AAPL barely mentioned in roundup", relevanceScore: "0.1", sentimentScore: "0.5" }]);
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"]);
    expect(res.AAPL).toEqual({}); // dropped entirely — never a fabricated partial row
  });

  it("with the filter ON (default), an item at/above the relevance threshold passes through normally", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.NEWS_RELEVANCE_MIN_SCORE = "0.35";

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("function=EARNINGS_CALENDAR")) {
        return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n");
      }
      return feedResponse([{ title: "AAPL reports record quarterly revenue", relevanceScore: "0.9", sentimentScore: "0.5" }]);
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"]);
    expect(res.AAPL?.headlines).toEqual(["AAPL reports record quarterly revenue"]);
    expect(res.AAPL?.sentiment).toBe(100);
  });

  it("an item with NO relevance_score at all passes through even with the filter ON — never drop data AV didn't score", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.NEWS_RELEVANCE_MIN_SCORE = "0.99"; // would fail almost anything WITH a score

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("function=EARNINGS_CALENDAR")) {
        return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n");
      }
      return feedResponse([{ title: "AAPL unscored mention", sentimentScore: "0.2" }]); // no relevance_score field
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"]);
    expect(res.AAPL?.headlines).toEqual(["AAPL unscored mention"]);
    expect(res.AAPL?.sentiment).toBe(70); // 50 + 0.2*100
  });

  it("with the filter OFF, a below-threshold relevance_score no longer drops the item", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.NEWS_RELEVANCE_FILTER = "0";
    process.env.NEWS_RELEVANCE_MIN_SCORE = "0.99"; // would fail the 0.1 relevance_score if filter were on

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("function=EARNINGS_CALENDAR")) {
        return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n");
      }
      return feedResponse([{ title: "AAPL barely mentioned in roundup", relevanceScore: "0.1", sentimentScore: "0.5" }]);
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res = await provider.enrich(["AAPL"]);
    expect(res.AAPL?.headlines).toEqual(["AAPL barely mentioned in roundup"]);
    expect(res.AAPL?.sentiment).toBe(100);
  });

  it("parseAlphaVantageNewsSentiment (RapidAPI failover lane) applies the same relevance gating", async () => {
    const { parseAlphaVantageNewsSentiment } = await import("../src/lib/data-providers");
    process.env.NEWS_RELEVANCE_MIN_SCORE = "0.35";
    const payload = {
      feed: [
        { title: "Relevant AAPL headline", ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.5", relevance_score: "0.9" }] },
        { title: "Barely-relevant AAPL mention", ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.5", relevance_score: "0.05" }] }
      ]
    };
    const parsed = parseAlphaVantageNewsSentiment(payload, "AAPL");
    expect(parsed.headlines).toEqual(["Relevant AAPL headline"]);
  });
});

describe("Yahoo Finance provider — cookie/crumb handshake retry", () => {
  // Isolate Yahoo: clear every other enrichment key so the cascade cannot fill PE from
  // Fintech/Finnhub/FMP/etc. when Yahoo handshake fails (CI runners often have keys in env).
  const KEYS = [
    "FINNHUB_API_KEY",
    "FMP_API_KEY",
    "ALPHAVANTAGE_API_KEY",
    "FINTECH_STUDIOS_API_KEY",
    "RAPIDAPI_KEY",
    "POLYGON_API_KEY",
    "ALPACA_API_KEY",
    "ALPACA_API_SECRET",
    "ROIC_API_KEY",
    "MASSIVE_API_KEY",
    "MASSIVE_API_KEY_ALT",
    "TIINGO_API_KEY",
    "TWELVEDATA_API_KEY",
    "FILINGAPI",
    "FILINGAPI_KEY",
    "SEC_XBRL_ENRICHMENT_ENABLED",
  ] as const;
  const originals: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  for (const k of KEYS) originals[k] = process.env[k];

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    // Keep Yahoo crumb tests free of SEC/FilingAPI network side-channels.
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "0";
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = originals[k];
      if (v) process.env[k] = v;
      else delete process.env[k];
    }
  });

  // Composite review (d): getCreds() used to be all-or-nothing — one failed handshake blanked
  // Yahoo enrichment for EVERY symbol this run. It now retries once with a short backoff.
  it("retries the cookie/crumb handshake once after a transient failure, instead of blanking the whole batch", async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let cookieAttempts = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      // Free-wave nasdaq-quote may run alongside Yahoo — return empty so it doesn't win fields.
      if (u.includes("api.nasdaq.com")) {
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      }
      if (u === "https://fc.yahoo.com") {
        cookieAttempts++;
        if (cookieAttempts === 1) throw new Error("network blip");
        return new Response(null, { status: 200, headers: { "set-cookie": "A=1; Path=/" } });
      }
      if (u.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) {
        return new Response("test-crumb", { status: 200 });
      }
      if (u.startsWith("https://query1.finance.yahoo.com/v10/finance/quoteSummary/")) {
        return new Response(
          JSON.stringify({
            quoteSummary: {
              result: [{ summaryDetail: { trailingPE: { raw: 31.4 } }, assetProfile: { sector: "Technology" } }]
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const provider = getEnrichmentProvider();
    expect(provider.name).toContain("yahoo-finance");

    // Real timers: free-wave nasdaq-quote runs alongside Yahoo; fake timers previously
    // deadlocked the cascade Promise.race with Yahoo's 500ms crumb retry.
    const result = await provider.enrich(["AAPL"]);
    expect(result.AAPL?.peRatio).toBe(31.4);
    expect(result.AAPL?.sector).toBe("Technology");
    expect(cookieAttempts).toBe(2); // failed once, retried once, succeeded
  });

  it("maps analyst targets, revenue growth, and freeCashFlowYield from the already-fetched financialData module (free tier)", async () => {
    // Owner directive 2026-08-01: with FMP suspended and no paid target source, the free Yahoo
    // quoteSummary financialData module must populate target*/revenueGrowth/freeCashFlowYield.
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("api.nasdaq.com")) return new Response(JSON.stringify({ data: null }), { status: 200 });
      if (u === "https://fc.yahoo.com") return new Response(null, { status: 200, headers: { "set-cookie": "A=1; Path=/" } });
      if (u.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) return new Response("test-crumb", { status: 200 });
      if (u.startsWith("https://query1.finance.yahoo.com/v10/finance/quoteSummary/")) {
        return new Response(
          JSON.stringify({
            quoteSummary: {
              result: [{
                summaryDetail: { marketCap: { raw: 3_000_000_000_000 } },
                financialData: {
                  targetMeanPrice: { raw: 250.5 },
                  targetHighPrice: { raw: 300 },
                  targetLowPrice: { raw: 180 },
                  targetMedianPrice: { raw: 247 },
                  revenueGrowth: { raw: 0.094 }, // decimal fraction → 9.4 percentage points
                  freeCashflow: { raw: 100_000_000_000 },
                },
                assetProfile: {},
              }]
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const provider = getEnrichmentProvider();
    const result = await provider.enrich(["AAPL"]);
    expect(result.AAPL?.targetMean).toBe(250.5);
    expect(result.AAPL?.targetHigh).toBe(300);
    expect(result.AAPL?.targetLow).toBe(180);
    expect(result.AAPL?.targetMedian).toBe(247);
    expect(result.AAPL?.revenueGrowth).toBeCloseTo(9.4, 5);
    expect(result.AAPL?.fcfYield).toBeCloseTo(3.33, 2);
    expect(result.AAPL?.freeCashFlowYield).toBe(result.AAPL?.fcfYield);
  });

  it("drops zero/negative analyst targets (sentinel values) instead of letting them win first-wins", async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("api.nasdaq.com")) return new Response(JSON.stringify({ data: null }), { status: 200 });
      if (u === "https://fc.yahoo.com") return new Response(null, { status: 200, headers: { "set-cookie": "A=1; Path=/" } });
      if (u.startsWith("https://query1.finance.yahoo.com/v1/test/getcrumb")) return new Response("test-crumb", { status: 200 });
      if (u.startsWith("https://query1.finance.yahoo.com/v10/finance/quoteSummary/")) {
        return new Response(
          JSON.stringify({
            quoteSummary: { result: [{ financialData: { targetMeanPrice: { raw: 0 }, revenueGrowth: { raw: -0.02 } }, assetProfile: {} }] }
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const provider = getEnrichmentProvider();
    const result = await provider.enrich(["AAPL"]);
    expect(result.AAPL?.targetMean).toBeUndefined();
    expect(result.AAPL?.revenueGrowth).toBe(-2); // negative growth is real data, kept
  });

  it("still degrades to empty (never throws) when the retry also fails", async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("api.nasdaq.com")) {
        return new Response(JSON.stringify({ data: null }), { status: 200 });
      }
      if (u === "https://fc.yahoo.com") throw new Error("network down");
      throw new Error(`unexpected fetch to ${url}`);
    });

    const provider = getEnrichmentProvider();
    const result = await provider.enrich(["AAPL"]);
    expect(result.AAPL?.peRatio).toBeUndefined();
    expect(result.AAPL?.sector).toBeUndefined();
  });
});

// ── AlpacaSnapshotEnrichmentProvider ─────────────────────────────────────────

describe("parseRobinhoodFundamentals", () => {
  // Real shape from a live get_equity_fundamentals(["AAPL"]) call (2026-07-01), trimmed to
  // the fields the parser reads. Robinhood returns numeric fields as strings.
  const liveAaplRow = {
    symbol: "AAPL",
    average_volume: "81911063.910945",
    average_volume_2_weeks: "81911063.910945",
    high_52_weeks: "317.400000",
    low_52_weeks: "201.500000",
    pe_ratio: "34.082139",
    sector: "Electronic Technology",
    industry: "Telecommunications Equipment"
  };

  it("maps the verified-reliable numeric fields, parsing Robinhood's string-encoded numbers", () => {
    const result = parseRobinhoodFundamentals(liveAaplRow);
    expect(result.peRatio).toBeCloseTo(34.082139);
    expect(result.fiftyTwoWeekHigh).toBe(317.4);
    expect(result.fiftyTwoWeekLow).toBe(201.5);
    expect(result.volume).toBeCloseTo(81911063.910945);
  });

  it("never maps sector/industry — Robinhood's taxonomy doesn't match the app's GICS-style sectorCaps keys", () => {
    // Regression: Robinhood's own sector taxonomy ("Electronic Technology" for AAPL) differs
    // from the GICS-style taxonomy used elsewhere (Yahoo/Finnhub, and whatever a user
    // configures in policy.sectorCaps). SymbolEnrichment.sector feeds real sector-cap risk
    // enforcement via market.ts -> policy.ts's sectorForSymbol/sectorCapFor, so silently
    // passing this through would make sector caps stop matching for affected symbols.
    const result = parseRobinhoodFundamentals(liveAaplRow);
    expect(result).not.toHaveProperty("sector");
    expect(result).not.toHaveProperty("industry");
  });

  it("omits a field entirely when it is missing, zero, or unparseable rather than defaulting to 0", () => {
    const result = parseRobinhoodFundamentals({ symbol: "ZZZ", pe_ratio: "0", high_52_weeks: null });
    expect(result).not.toHaveProperty("peRatio");
    expect(result).not.toHaveProperty("fiftyTwoWeekHigh");
  });
});

describe("parseAlpacaSnapshot", () => {
  it("maps a full snapshot to the correct SymbolEnrichment fields", () => {
    const snap = {
      latestTrade: { p: 205.75 },
      latestQuote: { bp: 205.50, ap: 205.80 },
      dailyBar: { o: 203.00, h: 206.50, l: 202.00, c: 205.60, v: 1_250_000, vw: 204.42 },
      prevDailyBar: { c: 200.00 }
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(205.75);         // latestTrade.p preferred over dailyBar.c
    expect(result.bid).toBe(205.50);
    expect(result.ask).toBe(205.80);
    expect(result.volume).toBe(1_250_000);
    expect(result.vwap).toBe(204.42);          // dailyBar.vw mapped to vwap
    // (205.60 - 200.00) / 200.00 * 100 = 2.80%
    expect(result.intradayChangePct).toBeCloseTo(2.80, 2);
  });

  it("maps dailyBar.vw to vwap only when it is a positive number", () => {
    const result = parseAlpacaSnapshot({
      latestTrade: { p: 12.34 },
      dailyBar: { c: 12.34, v: 100_000, vw: 12.31 }
    });
    expect(result.vwap).toBe(12.31);
  });

  it("omits vwap when dailyBar.vw is missing or zero", () => {
    // vw absent entirely
    const noVw = parseAlpacaSnapshot({
      latestTrade: { p: 50.00 },
      dailyBar: { c: 50.00, v: 10_000 }
    });
    expect(noVw).not.toHaveProperty("vwap");

    // vw present but zero — never fabricate
    const zeroVw = parseAlpacaSnapshot({
      latestTrade: { p: 50.00 },
      dailyBar: { c: 50.00, v: 10_000, vw: 0 }
    });
    expect(zeroVw).not.toHaveProperty("vwap");

    // vw negative — never fabricate
    const negVw = parseAlpacaSnapshot({
      latestTrade: { p: 50.00 },
      dailyBar: { c: 50.00, v: 10_000, vw: -1 }
    });
    expect(negVw).not.toHaveProperty("vwap");
  });

  it("uses the two-sided mid when latestTrade is absent and ignores the daily bar close", () => {
    const snap = {
      latestQuote: { bp: 100.00, ap: 100.10 },
      dailyBar: { c: 90, v: 500_000 },
      prevDailyBar: { c: 98.00 }
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(100.05);
    expect(result.price).not.toBe(90);
    // Change still uses the daily bar close as the session reference: (90 - 98) / 98.
    expect(result.intradayChangePct).toBeCloseTo(-8.16, 1);
  });

  it("omits bid/ask when they are absent or zero", () => {
    const snap = {
      latestTrade: { p: 50.00 },
      latestQuote: { bp: 0, ap: undefined as unknown as number },
      dailyBar: { c: 50.00, v: 10_000 },
      prevDailyBar: { c: 49.00 }
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(50.00);
    expect(result).not.toHaveProperty("bid");
    expect(result).not.toHaveProperty("ask");
  });

  it("omits intradayChangePct when prevDailyBar is missing", () => {
    const snap = {
      latestTrade: { p: 75.00 },
      latestQuote: { bp: 74.90, ap: 75.10 },
      dailyBar: { c: 75.00, v: 300_000 }
      // no prevDailyBar
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(75.00);
    expect(result.bid).toBe(74.90);
    expect(result.ask).toBe(75.10);
    expect(result).not.toHaveProperty("intradayChangePct");
  });

  it("returns an empty object for a null/undefined snapshot", () => {
    expect(parseAlpacaSnapshot(null)).toEqual({});
    expect(parseAlpacaSnapshot(undefined)).toEqual({});
  });

  // Composite review D/high/S: "Per-field freshness (asOf) map on quotes + Alpaca-snapshot asOf" —
  // parseAlpacaSnapshot never set asOf before, so the maxQuoteAgeSec staleness gate (policy.ts)
  // could not see that the snapshot was served from a stale cache entry.
  describe("asOf stamping (staleness-gate visibility)", () => {
    it("stamps asOf from latestTrade.t when latestTrade.p wins the price", () => {
      const result = parseAlpacaSnapshot({
        latestTrade: { p: 205.75, t: "2026-07-04T14:30:00Z" },
        dailyBar: { c: 205.60, v: 1_000_000, t: "2026-07-04T00:00:00Z" }
      });
      expect(result.price).toBe(205.75);
      expect(result.asOf).toBe("2026-07-04T14:30:00Z");
    });

    it("stamps asOf from the quote time when the mid wins, not the daily bar time", () => {
      const result = parseAlpacaSnapshot({
        latestQuote: { bp: 100.00, ap: 100.10, t: "2026-07-04T14:30:00Z" },
        dailyBar: { c: 90, v: 500_000, t: "2026-07-04T20:00:00Z" }
      });
      expect(result.price).toBe(100.05);
      expect(result.asOf).toBe("2026-07-04T14:30:00Z");
    });

    it("omits price and asOf when the snapshot only has a daily or previous close", () => {
      const result = parseAlpacaSnapshot({
        dailyBar: { c: 100.05, v: 500_000, t: "2026-07-04T20:00:00Z" },
        prevDailyBar: { c: 98 }
      });
      expect(result.price).toBeUndefined();
      expect(result.asOf).toBeUndefined();
    });

    it("omits asOf when no timestamp backs the winning price field (never guesses)", () => {
      const result = parseAlpacaSnapshot({
        latestTrade: { p: 50.00 }, // no .t
        dailyBar: { c: 50.00, v: 10_000 }
      });
      expect(result.price).toBe(50.00);
      expect(result).not.toHaveProperty("asOf");
    });

    it("omits asOf for an unparsable timestamp string", () => {
      const result = parseAlpacaSnapshot({
        latestTrade: { p: 50.00, t: "not-a-timestamp" }
      });
      expect(result).not.toHaveProperty("asOf");
    });
  });
});

describe("alpacaSnapshotTtlMs — per-data-class TTL (quote-family, not fundamentals)", () => {
  const original = process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS;
    else process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS = original;
  });

  it("defaults to ~30s — far shorter than the 6h fundamentals ttlMs()", () => {
    delete process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS;
    expect(alpacaSnapshotTtlMs()).toBe(30_000);
  });

  it("is configurable independently of NEWS_CACHE_TTL_MS", () => {
    process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS = "5000";
    expect(alpacaSnapshotTtlMs()).toBe(5000);
  });

  it("falls back to the default for a non-finite/negative override", () => {
    process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS = "not-a-number";
    expect(alpacaSnapshotTtlMs()).toBe(30_000);
    process.env.ALPACA_SNAPSHOT_CACHE_TTL_MS = "-5";
    expect(alpacaSnapshotTtlMs()).toBe(30_000);
  });
});

describe("alpacaDataFeed", () => {
  const original = process.env.ALPACA_DATA_FEED;
  afterEach(() => {
    if (original === undefined) delete process.env.ALPACA_DATA_FEED;
    else process.env.ALPACA_DATA_FEED = original;
  });

  it("defaults to iex when unset", () => {
    delete process.env.ALPACA_DATA_FEED;
    expect(alpacaDataFeed()).toBe("iex");
  });

  it("honors the allowed feeds (iex|sip|otc), case-insensitively", () => {
    process.env.ALPACA_DATA_FEED = "sip";
    expect(alpacaDataFeed()).toBe("sip");
    process.env.ALPACA_DATA_FEED = "OTC";
    expect(alpacaDataFeed()).toBe("otc");
    process.env.ALPACA_DATA_FEED = "  IEX  ";
    expect(alpacaDataFeed()).toBe("iex");
  });

  it("falls back to iex for any disallowed value", () => {
    process.env.ALPACA_DATA_FEED = "delayed_sip";
    expect(alpacaDataFeed()).toBe("iex");
    process.env.ALPACA_DATA_FEED = "";
    expect(alpacaDataFeed()).toBe("iex");
  });
});

describe("AlpacaSnapshotEnrichmentProvider", () => {
  const originalFeed = process.env.ALPACA_DATA_FEED;
  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFeed === undefined) delete process.env.ALPACA_DATA_FEED;
    else process.env.ALPACA_DATA_FEED = originalFeed;
  });

  it("honors ALPACA_DATA_FEED in the request URL and maps vwap from dailyBar.vw", async () => {
    process.env.ALPACA_DATA_FEED = "sip";
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 195.50 },
            latestQuote: { bp: 195.40, ap: 195.60 },
            dailyBar: { c: 195.30, v: 2_000_000, vw: 195.12 },
            prevDailyBar: { c: 192.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("key-id", "key-secret", "env");
    const result = await provider.enrich(["AAPL"]);

    expect(capturedUrl).toContain("feed=sip");
    expect(capturedUrl).not.toContain("feed=iex");
    expect(result.AAPL?.vwap).toBe(195.12);
  });

  it("uses feed=iex in the request URL when ALPACA_DATA_FEED is unset", async () => {
    delete process.env.ALPACA_DATA_FEED;
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          AAPL: { latestTrade: { p: 1 }, dailyBar: { c: 1, v: 1 }, prevDailyBar: { c: 1 } }
        })
      );
    });
    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s", "env");
    await provider.enrich(["AAPL"]);
    expect(capturedUrl).toContain("feed=iex");
  });

  it("fetches the snapshots endpoint with correct headers and maps fields", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 195.50 },
            latestQuote: { bp: 195.40, ap: 195.60 },
            dailyBar: { o: 193.00, h: 196.00, l: 192.00, c: 195.30, v: 2_000_000 },
            prevDailyBar: { c: 192.00 }
          },
          MSFT: {
            latestTrade: { p: 421.10 },
            latestQuote: { bp: 421.00, ap: 421.20 },
            dailyBar: { o: 418.00, h: 422.00, l: 417.00, c: 421.00, v: 800_000 },
            prevDailyBar: { c: 418.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("key-id", "key-secret", "env");
    const result = await provider.enrich(["AAPL", "MSFT"]);

    // Headers
    expect(capturedHeaders["APCA-API-KEY-ID"]).toBe("key-id");
    expect(capturedHeaders["APCA-API-SECRET-KEY"]).toBe("key-secret");
    // URL contains both symbols and the iex feed
    expect(capturedUrl).toContain("feed=iex");
    expect(capturedUrl).toContain("AAPL");
    expect(capturedUrl).toContain("MSFT");

    // AAPL
    expect(result.AAPL?.price).toBe(195.50);
    expect(result.AAPL?.bid).toBe(195.40);
    expect(result.AAPL?.ask).toBe(195.60);
    expect(result.AAPL?.volume).toBe(2_000_000);
    // (195.30 - 192.00) / 192.00 * 100 = 1.72%
    expect(result.AAPL?.intradayChangePct).toBeCloseTo(1.72, 1);

    // MSFT
    expect(result.MSFT?.price).toBe(421.10);
    expect(result.MSFT?.bid).toBe(421.00);
    expect(result.MSFT?.ask).toBe(421.20);
    expect(result.MSFT?.volume).toBe(800_000);
    // (421.00 - 418.00) / 418.00 * 100 = 0.72%
    expect(result.MSFT?.intradayChangePct).toBeCloseTo(0.72, 1);
  });

  it("caches results and avoids a second network call", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 200.00 },
            latestQuote: { bp: 199.90, ap: 200.10 },
            dailyBar: { c: 200.00, v: 1_000_000 },
            prevDailyBar: { c: 198.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s");
    const r1 = await provider.enrich(["AAPL"]);
    expect(r1.AAPL?.price).toBe(200.00);
    expect(fetchCount).toBe(1);

    const r2 = await provider.enrich(["AAPL"]);
    expect(r2.AAPL?.price).toBe(200.00);
    expect(fetchCount).toBe(1); // cache hit — no second fetch
  });

  // Composite review D/high/S: the snapshot used to share the blanket 6h fundamentals ttlMs(), so a
  // real-time price could replay from cache for up to 6h. It now gets its own short (~30s)
  // alpacaSnapshotTtlMs() — this pins down that a cached snapshot actually expires quickly.
  it("re-fetches after the short (~30s) quote-family TTL expires, unlike the 6h fundamentals cache", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 200.00 },
            latestQuote: { bp: 199.90, ap: 200.10 },
            dailyBar: { c: 200.00, v: 1_000_000 },
            prevDailyBar: { c: 198.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s");
    vi.useFakeTimers();
    try {
      const r1 = await provider.enrich(["AAPL"]);
      expect(r1.AAPL?.price).toBe(200.00);
      expect(fetchCount).toBe(1);

      // Still within the ~30s TTL — cache hit.
      vi.advanceTimersByTime(10_000);
      const r2 = await provider.enrich(["AAPL"]);
      expect(r2.AAPL?.price).toBe(200.00);
      expect(fetchCount).toBe(1);

      // Past the ~30s TTL — must re-fetch (would still be cached under the old 6h ttlMs()).
      vi.advanceTimersByTime(25_000);
      const r3 = await provider.enrich(["AAPL"]);
      expect(r3.AAPL?.price).toBe(200.00);
      expect(fetchCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty objects on HTTP error and does not cache", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response("Unauthorized", { status: 401 });
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("bad-key", "bad-secret");
    const r1 = await provider.enrich(["AAPL"]);
    expect(r1.AAPL).toEqual({});
    expect(fetchCount).toBe(1);

    // No cache written — second call should hit network again
    const r2 = await provider.enrich(["AAPL"]);
    expect(r2.AAPL).toEqual({});
    expect(fetchCount).toBe(2);
  });

  it("does not fabricate bid/ask when the snapshot has zero quotes", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          TSLA: {
            latestTrade: { p: 175.00 },
            latestQuote: { bp: 0, ap: 0 }, // zero = not available, must not be set
            dailyBar: { c: 175.00, v: 500_000 },
            prevDailyBar: { c: 172.00 }
          }
        })
      )
    );

    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s");
    const result = await provider.enrich(["TSLA"]);
    expect(result.TSLA?.price).toBe(175.00);
    expect(result.TSLA).not.toHaveProperty("bid");
    expect(result.TSLA).not.toHaveProperty("ask");
  });

  it("converts a hyphenated share-class symbol (BRK-B) to Alpaca's dot notation in the request and maps the response back", async () => {
    // Regression: Alpaca's snapshots endpoint 400s an entire batch when it contains an
    // unconverted hyphenated symbol — confirmed in production (~97% failure rate on batches
    // that included BRK-B from the S&P 500 scan universe) before this fix.
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          "BRK.B": {
            latestTrade: { p: 410.00 },
            dailyBar: { c: 409.50, v: 1_000_000 },
            prevDailyBar: { c: 408.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s");
    const result = await provider.enrich(["BRK-B"]);

    expect(capturedUrl).toContain("BRK.B");
    expect(capturedUrl).not.toContain("BRK-B");
    expect(result["BRK-B"]?.price).toBe(410.00);
  });
});

describe("AlpacaNewsEnrichmentProvider", () => {
  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts a hyphenated share-class symbol to Alpaca's dot notation in the request and maps tagged articles back", async () => {
    const { AlpacaNewsEnrichmentProvider } = await import("../src/lib/data-providers");
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          news: [{ headline: "Berkshire posts strong quarter", symbols: ["BRK.B"] }]
        })
      );
    });

    const provider = new AlpacaNewsEnrichmentProvider("key-id", "key-secret");
    const result = await provider.enrich(["BRK-B"]);

    expect(capturedUrl).toContain("BRK.B");
    expect(capturedUrl).not.toContain("BRK-B");
    expect(result["BRK-B"]?.headlines).toContain("Berkshire posts strong quarter");
  });

  it("matches Alpaca news tags when the requested share-class symbol is already dot-form", async () => {
    const { AlpacaNewsEnrichmentProvider } = await import("../src/lib/data-providers");
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          news: [{ headline: "Berkshire stays active in markets", symbols: ["BRK.B"] }]
        })
      );
    });

    const provider = new AlpacaNewsEnrichmentProvider("key-id", "key-secret");
    const result = await provider.enrich(["BRK.B"]);

    expect(capturedUrl).toContain("BRK.B");
    expect(result["BRK-B"]?.headlines).toContain("Berkshire stays active in markets");
    expect(result["BRK.B"]?.headlines).toContain("Berkshire stays active in markets");
  });
});

// Freshness-tier ordering: the real-time Alpaca snapshot must win the price-family
// fields (price/bid/ask/volume) over a DELAYED provider that also returns them, because
// it is seated FIRST in the cascade. This locks in the reorder in getEnrichmentProvider.
describe("freshness-tier ordering — real-time Alpaca wins price-family fields", () => {
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalAlpacaKey = process.env.ALPACA_PAPER_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_PAPER_SECRET_KEY;

  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.ALPACA_PAPER_API_KEY = "alpaca-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "alpaca-secret";
    process.env.FINNHUB_API_KEY = "finnhub-key";
    // Alpaca MARKET DATA uses the operator's env paper key as a shared source for background scans
    // (no userId) — so the Alpaca enrichment provider seats without any per-user key. (Trading still
    // resolves Alpaca strictly per-user; this only affects read-only data.)
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFinnhubKey) process.env.FINNHUB_API_KEY = originalFinnhubKey;
    else delete process.env.FINNHUB_API_KEY;
    if (originalAlpacaKey) process.env.ALPACA_PAPER_API_KEY = originalAlpacaKey;
    else delete process.env.ALPACA_PAPER_API_KEY;
    if (originalAlpacaSecret) process.env.ALPACA_PAPER_SECRET_KEY = originalAlpacaSecret;
    else delete process.env.ALPACA_PAPER_SECRET_KEY;
  });

  it("seats alpaca-snapshot ahead of the delayed finnhub provider in the cascade", () => {
    const provider = getEnrichmentProvider(); // no userId → operator's shared Alpaca data key
    const order = provider.name.split("+");
    expect(order).toContain("alpaca-snapshot");
    expect(order).toContain("finnhub");
    // Real-time tier must resolve before the delayed quote/fundamentals tier.
    expect(order.indexOf("alpaca-snapshot")).toBeLessThan(order.indexOf("finnhub"));
  });

  it("takes Alpaca's real-time price/bid/ask/volume over a delayed provider's value", async () => {
    // Alpaca's real-time snapshot and Finnhub's delayed quote BOTH return a volume for
    // AAPL, but with DIFFERENT numbers. The first-wins cascade must keep Alpaca's because
    // it is seated first. Route fetch by host so each provider gets its own payload; every
    // other URL (Finnhub's other 4 endpoints, Yahoo's crumb/quoteSummary) returns benign empty.
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("data.alpaca.markets/v2/stocks/snapshots")) {
        return new Response(
          JSON.stringify({
            AAPL: {
              latestTrade: { p: 195.50 },
              latestQuote: { bp: 195.40, ap: 195.60 },
              dailyBar: { c: 195.30, v: 2_000_000 },
              prevDailyBar: { c: 192.00 }
            }
          })
        );
      }
      if (url.includes("finnhub.io/api/v1/quote")) {
        // Delayed quote: a DIFFERENT (stale) volume that must lose to Alpaca's.
        return new Response(JSON.stringify({ c: 190.00, v: 9_999_999 }));
      }
      // Finnhub company-news returns an array; everything else an empty object/array.
      if (url.includes("finnhub.io/api/v1/company-news")) return new Response(JSON.stringify([]));
      if (url.includes("finnhub.io")) return new Response(JSON.stringify({}));
      // Yahoo crumb/quoteSummary and any other URL: empty so nothing throws.
      return new Response(JSON.stringify({}));
    });

    const provider = getEnrichmentProvider(); // no userId → operator's shared Alpaca data key
    const result = await provider.enrich(["AAPL"]);

    // Real-time Alpaca wins every price-family field…
    expect(result.AAPL?.price).toBe(195.50);
    expect(result.AAPL?.bid).toBe(195.40);
    expect(result.AAPL?.ask).toBe(195.60);
    // …including the field both providers returned (Alpaca 2,000,000 beats Finnhub 9,999,999).
    expect(result.AAPL?.volume).toBe(2_000_000);

    // …and each is stamped to the real-time source, proving Alpaca (not finnhub) supplied it.
    expect(result.AAPL?.sources?.price).toBe("alpaca-snapshot");
    expect(result.AAPL?.sources?.bid).toBe("alpaca-snapshot");
    expect(result.AAPL?.sources?.ask).toBe("alpaca-snapshot");
    expect(result.AAPL?.sources?.volume).toBe("alpaca-snapshot");
  });
});

// AV supplies ONLY NEWS_SENTIMENT; when Alpaca news is configured it already covers that field,
// so registering AV too would just burn its 25/day free cap for nothing (see the registration
// site comment in getEnrichmentProvider).
describe("Alpha Vantage deregistration when Alpaca news is configured", () => {
  const originalAlphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;
  const originalAlpacaKey = process.env.ALPACA_PAPER_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_PAPER_SECRET_KEY;

  beforeEach(() => {
    process.env.ALPHAVANTAGE_API_KEY = "av-key";
  });

  afterEach(() => {
    if (originalAlphaVantageKey) process.env.ALPHAVANTAGE_API_KEY = originalAlphaVantageKey;
    else delete process.env.ALPHAVANTAGE_API_KEY;
    if (originalAlpacaKey) process.env.ALPACA_PAPER_API_KEY = originalAlpacaKey;
    else delete process.env.ALPACA_PAPER_API_KEY;
    if (originalAlpacaSecret) process.env.ALPACA_PAPER_SECRET_KEY = originalAlpacaSecret;
    else delete process.env.ALPACA_PAPER_SECRET_KEY;
  });

  it("registers alpha-vantage when Alpaca news is NOT configured", () => {
    delete process.env.ALPACA_PAPER_API_KEY;
    delete process.env.ALPACA_PAPER_SECRET_KEY;
    const provider = getEnrichmentProvider();
    expect(provider.name.split("+")).toContain("alpha-vantage");
  });

  it("does not register alpha-vantage when Alpaca news is configured", () => {
    process.env.ALPACA_PAPER_API_KEY = "alpaca-key";
    // AlpacaNewsEnrichmentProvider only requires the API key (secret is optional) — mirror that
    // availability check here so this test doesn't accidentally depend on a stricter condition.
    delete process.env.ALPACA_PAPER_SECRET_KEY;
    const provider = getEnrichmentProvider();
    const order = provider.name.split("+");
    expect(order).toContain("alpaca-news");
    expect(order).not.toContain("alpha-vantage");
  });
});

describe("CascadingEnrichmentProvider.activeSources (honest source attribution)", () => {
  const stub = (name: string, data: Record<string, SymbolEnrichment>): MarketEnrichmentProvider => ({
    name,
    configured: true,
    async enrich() {
      return data;
    }
  });

  it("names only providers that supplied ≥1 accepted field, in registration order", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("alpha", { AAPL: { peRatio: 30 } }), // contributes peRatio
      stub("beta", {}), // contributes nothing — must NOT appear in the source string
      stub("gamma", { AAPL: { volume: 1000 } }) // contributes volume
    ]);
    await cascade.enrich(["AAPL"]);
    expect(cascade.activeSources).toEqual(["alpha", "gamma"]);
  });

  it("excludes a provider whose every field lost the first-wins race (added nothing new)", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("first", { AAPL: { peRatio: 30 } }),
      stub("second", { AAPL: { peRatio: 99 } }) // peRatio already filled → not accepted → not a contributor
    ]);
    await cascade.enrich(["AAPL"]);
    expect(cascade.activeSources).toEqual(["first"]);
  });

  it("counts an analyst-only contribution", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("rater", { AAPL: { analystBySource: { rater: { score: 80, label: "Buy" } } } })
    ]);
    await cascade.enrich(["AAPL"]);
    expect(cascade.activeSources).toEqual(["rater"]);
  });

  it("resets between runs (a provider that contributed before but not now drops out)", async () => {
    const cascade = new CascadingEnrichmentProvider([stub("only", { AAPL: { peRatio: 30 } })]);
    await cascade.enrich(["AAPL"]);
    expect(cascade.activeSources).toEqual(["only"]);
    await cascade.enrich(["MSFT"]); // no data for MSFT this run
    expect(cascade.activeSources).toEqual([]);
  });

  it("does NOT credit a provider whose analyst entry was overwritten by the same source", async () => {
    // App A surfaces an analyst row keyed under its upstream source ("fmp"); the direct
    // fmp provider runs later and overwrites that same key, so App A supplied no FINAL
    // value and must not appear in activeSources.
    const cascade = new CascadingEnrichmentProvider([
      stub("congress.trade", { AAPL: { analystBySource: { fmp: { score: 80, label: "Buy" } } } }),
      stub("fmp", { AAPL: { analystBySource: { fmp: { score: 20, label: "Sell" } } } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.analystBySource && Object.keys(out.AAPL.analystBySource)).toEqual(["fmp"]);
    expect(out.AAPL.analystScore).toBe(20); // fmp's surviving value — a single vote, not a 50 blend
    expect(cascade.activeSources).toEqual(["fmp"]);
    expect(cascade.activeSources).not.toContain("congress.trade");
  });

  it("drops the source-less congress.trade aggregate when granular votes exist (no double-count)", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("congress.trade", { AAPL: { analystBySource: { "congress.trade": { score: 90, label: "Strong Buy" } } } }),
      stub("fmp", { AAPL: { analystBySource: { fmp: { score: 20, label: "Sell" } } } }),
      stub("finnhub", { AAPL: { analystBySource: { finnhub: { score: 40, label: "Hold" } } } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    // Aggregate dropped → blend is fmp(20)+finnhub(40)=30, NOT (90+20+40)/3=50.
    expect(out.AAPL.analystScore).toBe(30);
    expect(out.AAPL.analystBySource && Object.keys(out.AAPL.analystBySource).sort()).toEqual(["finnhub", "fmp"]);
    expect(cascade.activeSources).not.toContain("congress.trade");
  });

  it("keeps the congress.trade aggregate when it is the only analyst signal", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("congress.trade", { AAPL: { analystBySource: { "congress.trade": { score: 90, label: "Strong Buy" } } } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.analystScore).toBe(90);
    expect(out.AAPL.analystBySource && Object.keys(out.AAPL.analystBySource)).toEqual(["congress.trade"]);
    expect(cascade.activeSources).toEqual(["congress.trade"]);
  });

  it("credits BOTH providers when their analyst entries are distinct sources", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("congress.trade", { AAPL: { analystBySource: { "yahoo-finance": { score: 80, label: "Buy" } } } }),
      stub("fmp", { AAPL: { analystBySource: { fmp: { score: 20, label: "Sell" } } } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.analystScore).toBe(50); // two distinct votes (80 + 20) blended
    expect(cascade.activeSources.sort()).toEqual(["congress.trade", "fmp"]);
  });
});

describe("CascadingEnrichmentProvider evidence receipts and arbitration", () => {
  const stub = (name: string, data: Record<string, SymbolEnrichment>): MarketEnrichmentProvider => ({
    name,
    configured: true,
    async enrich() {
      return data;
    }
  });

  it("keeps a provider failure distinct from a successful no-match response", async () => {
    const failed: MarketEnrichmentProvider = {
      name: "failed-provider",
      configured: true,
      async enrich() {
        throw new Error("upstream unavailable");
      }
    };
    const mixed = new CascadingEnrichmentProvider([failed, stub("no-match-provider", {})]);
    const mixedResult = await mixed.enrich(["AAPL"]);
    expect(mixedResult.AAPL.fieldObservations?.peRatio?.status).toBe("no_match");
    expect(mixedResult.AAPL.providerFailures?.["failed-provider"]).toMatchObject({
      source: "failed-provider",
      status: "failed",
      errorKind: "Error"
    });

    const allFailed = new CascadingEnrichmentProvider([failed]);
    const failedResult = await allFailed.enrich(["AAPL"]);
    expect(failedResult.AAPL.fieldObservations?.peRatio?.status).toBe("failed");
  });

  it("derives marketCap from SEC XBRL shares times live price when cap is missing", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { price: 200 } }),
      stub("sec-xbrl", { AAPL: { sharesOutstanding: 1_000_000 } })
    ]);
    const result = await cascade.enrich(["AAPL"]);
    expect(result.AAPL.marketCap).toBe(200_000_000);
    expect(result.AAPL.sources?.marketCap).toBe("sec-xbrl");
    expect(result.AAPL.sources?.sharesOutstanding).toBe("sec-xbrl");
  });

  it("preserves explicit field timestamps and upstream source metadata", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("redistributor", {
        AAPL: {
          peRatio: 22,
          fieldObservations: {
            peRatio: {
              value: 22,
              source: "sec-xbrl",
              upstreamFamily: "sec",
              observedAt: "2026-07-10T00:00:00.000Z",
              effectiveAt: "2026-06-30T00:00:00.000Z",
              fetchedAt: "2026-07-13T12:00:00.000Z",
              expiresAt: "2026-07-14T12:00:00.000Z",
              status: "ok",
              confidence: 0.9,
              reliability: 0.95,
              directness: 1
            }
          }
        }
      })
    ]);
    const result = await cascade.enrich(["AAPL"]);
    expect(result.AAPL.peRatio).toBe(22);
    expect(result.AAPL.sources?.peRatio).toBe("redistributor");
    expect(result.AAPL.fieldObservations?.peRatio).toMatchObject({
      source: "sec-xbrl",
      upstreamFamily: "sec",
      observedAt: "2026-07-10T00:00:00.000Z",
      effectiveAt: "2026-06-30T00:00:00.000Z",
      fetchedAt: "2026-07-13T12:00:00.000Z",
      expiresAt: "2026-07-14T12:00:00.000Z",
      status: "ok"
    });
  });

  it("arbitrates metadata-aware fields deterministically while retaining price registration priority", () => {
    const candidates = [
      {
        providerName: "first",
        registrationOrder: 0,
        observation: {
          value: 10,
          source: "first",
          status: "ok" as const,
          reliability: 0.8,
          directness: 1,
          observedAt: "2026-07-12T00:00:00.000Z"
        }
      },
      {
        providerName: "second",
        registrationOrder: 1,
        observation: {
          value: 20,
          source: "second",
          status: "ok" as const,
          reliability: 0.8,
          directness: 1,
          observedAt: "2026-07-13T00:00:00.000Z"
        }
      }
    ];
    expect(arbitrateFieldObservation("peRatio", candidates)?.observation.value).toBe(20);
    expect(arbitrateFieldObservation("price", candidates)?.observation.value).toBe(10);
  });

  it("deduplicates analyst votes by upstream family before blending", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("redistributor", {
        AAPL: { analystBySource: { "syndicated-fmp": { score: 80, label: "Buy", upstreamFamily: "fmp" } } }
      }),
      stub("fmp", {
        AAPL: { analystBySource: { "direct-fmp": { score: 20, label: "Sell", upstreamFamily: "fmp" } } }
      })
    ]);
    const result = await cascade.enrich(["AAPL"]);
    expect(result.AAPL.analystScore).toBe(20);
    expect(result.AAPL.analystBySource).toEqual({
      "direct-fmp": { score: 20, label: "Sell", upstreamFamily: "fmp" }
    });
    expect(cascade.activeSources).toEqual(["fmp"]);
  });
});

describe("enrichment short-circuit (App A coverage hint → paid providers skip redundant sub-calls)", () => {
  const FLAG = "ENRICHMENT_SHORT_CIRCUIT_ENABLED";
  // The short-circuit now gates on the fundamentals tier flag, not the price-read flag.
  const READS = "CONGRESS_TRADE_FUNDAMENTALS_ENABLED";
  const FREE_FIRST = "ENRICHMENT_FREE_FIRST_ENABLED";
  afterEach(() => {
    delete process.env[FLAG];
    delete process.env[READS];
    delete process.env[FREE_FIRST];
  });

  function appA(fundamentals: Record<string, SymbolEnrichment>): MarketEnrichmentProvider {
    return { name: "congress.trade", configured: true, costTier: "free", async enrich() { return fundamentals; } };
  }
  // Records the symbols it was called with AND the full context it received, faithfully
  // modelling FMP's source-aware sub-call skipping: P/E skipped when App A covers peRatio
  // (first-wins); consensus skipped only when App A's analyst source IS this provider.
  function paidSpy(calls: string[][], contexts: Array<EnrichmentContext | undefined>): MarketEnrichmentProvider {
    const NAME = "fmp";
    return {
      name: NAME,
      configured: true,
      costTier: "paid",
      async enrich(syms: string[], context?: EnrichmentContext) {
        calls.push(syms);
        contexts.push(context);
        const out: Record<string, SymbolEnrichment> = {};
        for (const s of syms) {
          const covered = context?.coveredFields?.[s];
          const skipPe = covered?.has("peRatio") ?? false;
          const skipConsensus = (covered?.has("analystRating") ?? false) && context?.analystSource?.[s] === NAME;
          out[s] = {
            // pe/analyst dropped only when its sub-call was skipped; insider/senate always
            // supplied — App A never covers them, so nothing FMP uniquely provides is lost.
            ...(skipPe ? {} : { peRatio: 99 }),
            ...(skipConsensus ? {} : { analystBySource: { [NAME]: { score: 20, label: "Sell" } } }),
            insiderSentiment: 70,
            senateTrades: 3,
          };
        }
        return out;
      }
    };
  }

  it("still runs every paid provider over every symbol, but hands them the coverage hint", async () => {
    process.env[FLAG] = "on";
    process.env[READS] = "on";
    const calls: string[][] = [];
    const contexts: Array<EnrichmentContext | undefined> = [];
    const cascade = new CascadingEnrichmentProvider([
      // AAA covered; BBB not. App A surfaces analyst as analystBySource (the cascade
      // derives the displayed rating from that, not the scalar).
      appA({
        AAA: { peRatio: 10, eps: 2, analystRating: "Buy", analystBySource: { "fmp": { score: 80, label: "Buy" } } },
      }),
      paidSpy(calls, contexts)
    ]);
    await cascade.enrich(["AAA", "BBB"]);
    // No whole-provider skip: the paid provider runs over BOTH symbols.
    expect(calls).toEqual([["AAA", "BBB"]]);
    // It received a per-symbol coverage hint (fields + analyst source) for AAA only.
    expect(contexts[0]?.coveredFields?.AAA?.has("peRatio")).toBe(true);
    expect(contexts[0]?.coveredFields?.AAA?.has("analystRating")).toBe(true);
    expect(contexts[0]?.analystSource?.AAA).toBe("fmp");
    // Free-first (default ON) records an empty covered set for symbols the free wave
    // returned nothing for — distinct from "key absent" under the legacy short-circuit path.
    expect(contexts[0]?.coveredFields?.BBB?.size ?? 0).toBe(0);
  });

  it("preserves the paid provider's unique fields for covered symbols (nothing lost)", async () => {
    process.env[FLAG] = "on";
    process.env[READS] = "on";
    const calls: string[][] = [];
    const contexts: Array<EnrichmentContext | undefined> = [];
    const cascade = new CascadingEnrichmentProvider([
      appA({ AAA: { peRatio: 10, eps: 2, analystRating: "Buy", analystBySource: { "fmp": { score: 80, label: "Buy" } } } }),
      paidSpy(calls, contexts)
    ]);
    const out = await cascade.enrich(["AAA"]);
    // App A's pe/analyst win; the paid provider's unique insider/senate still come through.
    expect(out.AAA.peRatio).toBe(10);
    expect(out.AAA.analystRating).toBe("Buy"); // App A (fmp-sourced), de-duped — single vote
    expect(out.AAA.insiderSentiment).toBe(70);
    expect(out.AAA.senateTrades).toBe(3);
  });

  it("still fetches FMP's own consensus when App A's analyst came from a DIFFERENT source", async () => {
    process.env[FLAG] = "on";
    process.env[READS] = "on";
    const calls: string[][] = [];
    const contexts: Array<EnrichmentContext | undefined> = [];
    const cascade = new CascadingEnrichmentProvider([
      // App A's analyst is Yahoo-sourced (score 80/"Buy"); FMP must still contribute its
      // own vote (score 20/"Sell"), so the blended score is the average of the two (~50).
      appA({ AAA: { peRatio: 10, eps: 2, analystRating: "Buy", analystBySource: { "yahoo-finance": { score: 80, label: "Buy" } } } }),
      paidSpy(calls, contexts)
    ]);
    const out = await cascade.enrich(["AAA"]);
    expect(contexts[0]?.analystSource?.AAA).toBe("yahoo-finance");
    // Two distinct votes (yahoo 80 + fmp 20) → blended ~50, NOT App A's 80 alone.
    expect(out.AAA.analystScore).toBe(50);
    expect(out.AAA.analystBySource && Object.keys(out.AAA.analystBySource).sort()).toEqual(["fmp", "yahoo-finance"]);
  });

  it("does not fail the free wave when congress.trade 404s", async () => {
    process.env[FLAG] = "on";
    process.env[READS] = "on";
    const cascade = new CascadingEnrichmentProvider([
      {
        name: "congress.trade",
        configured: true,
        costTier: "free",
        async enrich() {
          throw new Error("HTTP 404");
        }
      },
      {
        name: "yahoo-finance",
        configured: true,
        costTier: "free",
        async enrich() {
          return { AAA: { peRatio: 12 } };
        }
      }
    ]);
    const out = await cascade.enrich(["AAA"]);
    expect(out.AAA.peRatio).toBe(12);
  });

  it("does not latch gather when congress.trade 502s on the free-first wave", async () => {
    process.env[FLAG] = "on";
    process.env[READS] = "on";
    const cascade = new CascadingEnrichmentProvider([
      {
        name: "congress.trade",
        configured: true,
        costTier: "free",
        async enrich() {
          throw new Error("HTTP 502");
        }
      },
      {
        name: "yahoo-finance",
        configured: true,
        costTier: "free",
        async enrich() {
          return { AAA: { peRatio: 18 } };
        }
      }
    ]);
    const out = await cascade.enrich(["AAA"]);
    expect(out.AAA.peRatio).toBe(18);
  });

  it("does not latch gather when congress.trade 502s on the legacy short-circuit path", async () => {
    process.env[FLAG] = "on";
    process.env[READS] = "on";
    process.env[FREE_FIRST] = "0";
    const cascade = new CascadingEnrichmentProvider([
      {
        name: "congress.trade",
        configured: true,
        costTier: "free",
        async enrich() {
          throw new Error("HTTP 502");
        }
      },
      {
        name: "yahoo-finance",
        configured: true,
        costTier: "free",
        async enrich() {
          return { AAA: { peRatio: 19 } };
        }
      }
    ]);
    const out = await cascade.enrich(["AAA"]);
    expect(out.AAA.peRatio).toBe(19);
  });

  it("treats 502/429/timeout as latching and 404 as a miss", () => {
    expect(isLatchingEnrichmentTransportError(new Error("HTTP 502"))).toBe(true);
    expect(isLatchingEnrichmentTransportError(new Error("HTTP 429"))).toBe(true);
    expect(isLatchingEnrichmentTransportError(new Error("The operation was aborted due to timeout"))).toBe(true);
    expect(isLatchingEnrichmentTransportError(new Error("HTTP 404"))).toBe(false);
  });

  it("passes NO coverage hint when the flag is OFF (default)", async () => {
    process.env[READS] = "on"; // reads on, short-circuit off
    // Free-first also injects coveredFields for paid waves — disable it here so this test
    // asserts the legacy short-circuit-OFF contract in isolation.
    process.env[FREE_FIRST] = "0";
    const calls: string[][] = [];
    const contexts: Array<EnrichmentContext | undefined> = [];
    const cascade = new CascadingEnrichmentProvider([
      appA({ AAA: { peRatio: 10, eps: 2 } }),
      paidSpy(calls, contexts)
    ]);
    await cascade.enrich(["AAA", "BBB"]);
    expect(calls).toEqual([["AAA", "BBB"]]);
    expect(contexts[0]).toBeUndefined();
  });
});

describe("short-interest second source (Massive) — cross-check + disagreement bulletin", () => {
  const stub = (name: string, data: Record<string, SymbolEnrichment>): MarketEnrichmentProvider => ({
    name,
    configured: true,
    async enrich() {
      return data;
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SHORT_INTEREST_DISAGREEMENT_PCT_PT;
  });

  it("flags a disagreement when the primary and Massive second source differ beyond the threshold", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { shortPercentOfFloat: 20 } }),
      stub("massive", { AAPL: { shortPercentOfFloatSecondary: 5 } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.shortPercentOfFloat).toBe(20); // first-wins primary preserved
    expect(out.AAPL.shortPercentOfFloatSecondary).toBeUndefined(); // carrier never leaves the cascade
    expect(out.AAPL.shortInterestDisagreement).toBe(
      "Short interest disagreement: yahoo-finance 20.0% vs massive 5.0% (15.0pp apart)."
    );
    expect(cascade.activeSources).toContain("massive");
  });

  it("does NOT flag when the two sources agree within the threshold (carrier still dropped)", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { shortPercentOfFloat: 8 } }),
      stub("massive", { AAPL: { shortPercentOfFloatSecondary: 6 } }) // 2pp < 5pp default
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.shortInterestDisagreement).toBeUndefined();
    expect(out.AAPL.shortPercentOfFloatSecondary).toBeUndefined();
  });

  it("does NOT flag when only one source is present (no second source to compare)", async () => {
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { shortPercentOfFloat: 20 } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.shortInterestDisagreement).toBeUndefined();
    expect(out.AAPL.shortPercentOfFloat).toBe(20);
  });

  it("honors the SHORT_INTEREST_DISAGREEMENT_PCT_PT threshold override", async () => {
    process.env.SHORT_INTEREST_DISAGREEMENT_PCT_PT = "20"; // now 15pp gap is within tolerance
    const cascade = new CascadingEnrichmentProvider([
      stub("yahoo-finance", { AAPL: { shortPercentOfFloat: 20 } }),
      stub("massive", { AAPL: { shortPercentOfFloatSecondary: 5 } })
    ]);
    const out = await cascade.enrich(["AAPL"]);
    expect(out.AAPL.shortInterestDisagreement).toBeUndefined();
  });

  it("MassiveEnrichmentProvider computes short % of float = short_interest / free_float and uses Bearer auth", async () => {
    const { MassiveEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    const seenAuth: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) seenAuth.push(auth);
      if (String(url).includes("short-interest")) {
        return new Response(JSON.stringify({ status: "OK", results: [{ ticker: "AAPL", short_interest: 144248476 }] }));
      }
      if (String(url).includes("/float")) {
        return new Response(JSON.stringify({ status: "OK", results: [{ ticker: "AAPL", free_float: 13515457484 }] }));
      }
      return new Response(JSON.stringify({ results: [] }));
    });
    const provider = new MassiveEnrichmentProvider("massive-key", "env");
    const res = await provider.enrich(["AAPL"]);
    // 144,248,476 / 13,515,457,484 * 100 = 1.0672… → rounded to 1.07
    expect(res.AAPL?.shortPercentOfFloatSecondary).toBeCloseTo(1.07, 2);
    expect(seenAuth).toContain("Bearer massive-key");
  });

  it("MassiveEnrichmentProvider omits the field when float is missing/zero (never fabricates)", async () => {
    const { MassiveEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("short-interest")) {
        return new Response(JSON.stringify({ status: "OK", results: [{ ticker: "ZZZ", short_interest: 1000 }] }));
      }
      if (String(url).includes("/float")) {
        return new Response(JSON.stringify({ status: "OK", results: [{ ticker: "ZZZ", free_float: 0 }] }));
      }
      return new Response(JSON.stringify({ results: [] }));
    });
    const provider = new MassiveEnrichmentProvider("massive-key", "env");
    const res = await provider.enrich(["ZZZ"]);
    expect(res.ZZZ?.shortPercentOfFloatSecondary).toBeUndefined();
  });

  it("MassiveEnrichmentProvider tolerates a 404 (no row for the ticker) without throwing", async () => {
    const { MassiveEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    const provider = new MassiveEnrichmentProvider("massive-key", "env");
    const res = await provider.enrich(["NONE"]);
    expect(res.NONE).toEqual({});
  });

  it("MassiveEnrichmentProvider stops remaining symbols after the first 429", async () => {
    const { MassiveEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    });
    const provider = new MassiveEnrichmentProvider("massive-key", "env");
    const symbols = Array.from({ length: 20 }, (_, i) => `M${i}`);
    const res = await provider.enrich(symbols);
    expect(res.M0).toEqual({});
    expect(res.M19).toEqual({});
    expect(calls).toBeLessThan(20);
  });
});

describe("enrichment symbol budget covers the full scan candidate set (starvation regression)", () => {
  // Prod 2026-07-09T19:41Z: scanMarket enriched top-30 ranked + 8 event outliers + 4 held
  // names (42 symbols), but every provider sliced its list to a fixed 30 — the force-included
  // extras (systematically the owner's HELD positions) got zero fields from every provider.
  // The budget must cover candidateLimit + outlier reserve + a held-position allowance.
  const ranked = Array.from({ length: 30 }, (_, i) => `RNK${i}`);
  const outliers = Array.from({ length: 8 }, (_, i) => `EVT${i}`);
  const held = ["AAPL", "GOOG", "V", "KO"];
  // Held + outliers first, mirroring scanMarket's enrichment priority order.
  const candidates = [...held, ...outliers, ...ranked];

  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    delete process.env.FMP_MAX_SYMBOLS;
    delete process.env.MARKET_SCAN_LIMIT;
    delete process.env.MARKET_SCAN_EVENT_RESERVE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FMP_MAX_SYMBOLS;
    delete process.env.MARKET_SCAN_LIMIT;
    delete process.env.MARKET_SCAN_EVENT_RESERVE;
  });

  function stubSymbolRecordingFetch(): Set<string> {
    const fetched = new Set<string>();
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const symbol = new URL(String(url)).searchParams.get("symbol");
      if (symbol) fetched.add(symbol);
      return new Response(JSON.stringify({}));
    });
    return fetched;
  }

  it("enriches every candidate: candidateLimit + outlier reserve + held extras (the 42-symbol prod shape)", async () => {
    const { FinnhubEnrichmentProvider } = await import("../src/lib/data-providers");
    const fetched = stubSymbolRecordingFetch();
    const provider = new FinnhubEnrichmentProvider(`env-key-${randomUUID()}`, "env");
    const result = await provider.enrich(candidates);
    for (const symbol of candidates) {
      expect(fetched.has(symbol), `${symbol} was starved of enrichment`).toBe(true);
    }
    expect(Object.keys(result).length).toBe(candidates.length);
  });

  it("still covers the force-included extras when MARKET_SCAN_LIMIT pins the scan size", async () => {
    // MARKET_SCAN_LIMIT used to be consumed as the enrichment budget itself, re-creating
    // the starvation for any operator with it set; it is the candidate limit, so the
    // budget must sit ABOVE it (reserve + held allowance on top).
    process.env.MARKET_SCAN_LIMIT = "30";
    const { FinnhubEnrichmentProvider } = await import("../src/lib/data-providers");
    const fetched = stubSymbolRecordingFetch();
    const provider = new FinnhubEnrichmentProvider(`env-key-${randomUUID()}`, "env");
    await provider.enrich(candidates);
    for (const symbol of candidates) {
      expect(fetched.has(symbol), `${symbol} was starved of enrichment`).toBe(true);
    }
  });

  it("keeps FMP_MAX_SYMBOLS as an explicit operator throttle — unclamped, with NO default cap", async () => {
    process.env.FMP_MAX_SYMBOLS = "10";
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    let fetched = stubSymbolRecordingFetch();
    await new FinnhubEnrichmentProvider(`env-key-${randomUUID()}`, "env").enrich(candidates);
    expect(fetched.size).toBe(10);

    // The override is not silently clamped: an operator asking for 60 gets 60 (the old
    // MAX_SYMBOLS_CAP=50 would have quietly cut this — owner ruling 2026-07-09: no hard cap).
    process.env.FMP_MAX_SYMBOLS = "60";
    clearEnrichmentCache();
    fetched = stubSymbolRecordingFetch();
    const seventy = Array.from({ length: 70 }, (_, i) => `OVR${i}`);
    await new FinnhubEnrichmentProvider(`env-key-${randomUUID()}`, "env").enrich(seventy);
    expect(fetched.size).toBe(60);

    // No env set: the full requested list is enriched, however large. An account with more
    // than 50 positions must never see its held names starved by a provider-side ceiling.
    delete process.env.FMP_MAX_SYMBOLS;
    clearEnrichmentCache();
    fetched = stubSymbolRecordingFetch();
    const bigBook = Array.from({ length: 120 }, (_, i) => `POS${i}`);
    await new FinnhubEnrichmentProvider(`env-key-${randomUUID()}`, "env").enrich(bigBook);
    expect(fetched.size).toBe(120);
  });
});


describe("FMP / Quiver direct access retired (owner 2026-08-04)", () => {
  it("never registers FMP or Quiver even when keys are present", async () => {
    process.env.FMP_API_KEY = "should-not-register";
    process.env.QUIVER_API_KEY = "should-not-register";
    process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED = "off"; // isolate cascade name
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = getEnrichmentProvider();
    expect(provider.name).not.toMatch(/(^|\+)fmp($|\+)/);
    expect(provider.name).not.toContain("quiverquant");
    expect(provider.name).not.toContain("fmp-rapidapi");
    delete process.env.FMP_API_KEY;
    delete process.env.QUIVER_API_KEY;
    delete process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED;
  });
});


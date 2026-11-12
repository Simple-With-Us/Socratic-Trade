import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-quote-breaker-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "b".repeat(64);
});

async function load() {
  const breaker = await import("../src/lib/api-circuit-breaker");
  const providers = await import("../src/lib/data-providers");
  const db = await import("../src/lib/db");
  return { ...breaker, ...providers, getDb: db.getDb };
}

describe("paid quote provider circuit breaker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    delete process.env.QUOTE_PROVIDER_402_HOLD_MS;
    delete process.env.QUOTE_PROVIDER_429_BASE_MS;
    delete process.env.QUOTE_PROVIDER_429_CAP_MS;
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("holds a 429 only for a positive Retry-After and a 402 for hours", async () => {
    const { paidQuoteHoldMs, resetApiCircuitBreaker, quoteProvider402HoldMs } = await load();
    resetApiCircuitBreaker();
    expect(paidQuoteHoldMs("twelvedata", "env", 429, undefined)).toBe(0);
    expect(paidQuoteHoldMs("twelvedata", "env", 429, 12_000)).toBe(12_000);
    expect(paidQuoteHoldMs("roic", "env", 402, undefined)).toBe(quoteProvider402HoldMs());
    expect(quoteProvider402HoldMs()).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it("reports a cooling paid-quote lane without consuming the half-open probe", async () => {
    const {
      isPaidQuoteBreakerCooling,
      listOpenApiCircuitBreakers,
      resetApiCircuitBreaker,
      tripApiCircuitBreakerLane
    } = await load();
    resetApiCircuitBreaker();
    const now = 1_700_000_000_000;
    tripApiCircuitBreakerLane("marketstack", "env", 60_000, now, { reason: "rate-limit", status: 429 });
    expect(isPaidQuoteBreakerCooling("marketstack", "env", now + 1_000)).toBe(true);
    expect(isPaidQuoteBreakerCooling("marketstack", "user", now + 1_000)).toBe(false);
    expect(isPaidQuoteBreakerCooling("finnhub", "env", now + 1_000)).toBe(false);
    expect(listOpenApiCircuitBreakers(now + 1_000)).toHaveLength(1);
    expect(isPaidQuoteBreakerCooling("marketstack", "env", now + 60_000)).toBe(false);
    expect(listOpenApiCircuitBreakers(now + 60_000)).toHaveLength(0);
    expect(listOpenApiCircuitBreakers(now + 59_000)).toHaveLength(1);
  });

  it("opens on 429 Retry-After, then skips the next call with no fetch and no failure row", async () => {
    const {
      fetchWithRetry,
      apiCircuitBreakerShouldSkip,
      listOpenApiCircuitBreakers,
      resetApiCircuitBreaker,
      getDb
    } = await load();
    getDb();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;

    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async () => {
      const response = new Response("slow", { status: 429, headers: { "Retry-After": "1" } });
      vi.spyOn(response.body!, "cancel").mockImplementation(cancel);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchWithRetry("https://example.test/twelvedata", { cache: "no-store" }, {
      service: "twelvedata",
      keySource: "env",
      retries: 1,
      backoffMs: 1
    });
    expect(first.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalled();
    expect(apiCircuitBreakerShouldSkip("twelvedata", "env").skip).toBe(true);
    const open = listOpenApiCircuitBreakers();
    expect(open).toEqual([
      expect.objectContaining({
        service: "twelvedata",
        keySource: "env",
        reason: "rate-limit",
        status: 429
      })
    ]);
    expect(open[0].openForMs).toBeGreaterThan(500);

    fetchMock.mockClear();
    await expect(
      fetchWithRetry("https://example.test/twelvedata", { cache: "no-store" }, {
        service: "twelvedata",
        keySource: "env",
        retries: 1,
        backoffMs: 1
      })
    ).rejects.toMatchObject({ name: "CircuitOpenError" });
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM api_health_log WHERE service = ? AND ok = 0`)
      .all("twelvedata") as Array<{ c: number }>;
    // The trip wrote one soft row. The skip must not add another.
    const afterSkip = rows[0]?.c ?? 0;
    expect(afterSkip).toBe(1);
  });

  it("opens a 402 for hours and does not retry it", async () => {
    const { fetchWithRetry, listOpenApiCircuitBreakers, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    const fetchMock = vi.fn(async () => new Response("no credit", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/roic", { cache: "no-store" }, {
      service: "roic",
      keySource: "user",
      retries: 2,
      backoffMs: 1
    });
    expect(res.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const open = listOpenApiCircuitBreakers().find((row) => row.service === "roic");
    expect(open?.reason).toBe("quota");
    expect(open?.status).toBe(402);
    expect(open?.keySource).toBe("user");
    expect(open?.openForMs).toBeGreaterThan(5 * 60 * 60 * 1000);
    // A different credential lane stays closed.
    const { apiCircuitBreakerShouldSkip } = await load();
    expect(apiCircuitBreakerShouldSkip("roic", "env").skip).toBe(false);
  });

  it("does not open a paid quote lane on a header-less 429 after the retry budget", async () => {
    const { fetchWithRetry, listOpenApiCircuitBreakers, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    const fetchMock = vi.fn(async () => new Response("slow", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/tiingo", { cache: "no-store" }, {
      service: "tiingo",
      keySource: "env",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(listOpenApiCircuitBreakers().find((row) => row.service === "tiingo")).toBeUndefined();
  });

  it("still retries a non-quote 429 and only opens that lane for a positive Retry-After", async () => {
    const { fetchWithRetry, apiCircuitBreakerShouldSkip, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    const fetchMock = vi.fn(async () => new Response("slow", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/finnhub", { cache: "no-store" }, {
      service: "finnhub-quote-guard",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(apiCircuitBreakerShouldSkip("finnhub-quote-guard", null).skip).toBe(false);
  });

  it("counts one strike for a burst and never shortens an open hold", async () => {
    const { listOpenApiCircuitBreakers, observePaidQuoteStatus, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const now = 1_700_000_000_000;
    expect(observePaidQuoteStatus("twelvedata", "env", 429, undefined, now)).toBe(0);
    expect(observePaidQuoteStatus("twelvedata", "env", 429, undefined, now + 10)).toBe(0);
    expect(listOpenApiCircuitBreakers(now + 10)).toHaveLength(0);

    expect(observePaidQuoteStatus("twelvedata", "env", 429, 30_000, now + 20)).toBe(30_000);
    expect(listOpenApiCircuitBreakers(now + 20)[0]?.openForMs).toBe(30_000);

    expect(observePaidQuoteStatus("twelvedata", "env", 429, 1_000, now + 30)).toBe(1_000);
    const stillLong = listOpenApiCircuitBreakers(now + 30)[0];
    expect(stillLong?.openForMs).toBe(29_990);
    expect(stillLong?.reason).toBe("rate-limit");

    expect(observePaidQuoteStatus("twelvedata", "env", 402, undefined, now + 40)).toBeGreaterThan(60 * 60 * 1000);
    const quota = listOpenApiCircuitBreakers(now + 40)[0];
    expect(quota?.reason).toBe("quota");
    expect(quota?.openForMs).toBeGreaterThan(5 * 60 * 60 * 1000);

    expect(observePaidQuoteStatus("twelvedata", "env", 429, 1_000, now + 50)).toBe(1_000);
    const kept = listOpenApiCircuitBreakers(now + 50)[0];
    expect(kept?.reason).toBe("quota");
    expect(kept?.openForMs).toBeGreaterThan(5 * 60 * 60 * 1000);
  });

  it("parks one credential fingerprint and leaves another open", async () => {
    const { isPaidQuoteBreakerCooling, observePaidQuoteStatus, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const now = 1_700_000_000_000;
    observePaidQuoteStatus("twelvedata", "user", 402, undefined, now, "finger-a");
    expect(isPaidQuoteBreakerCooling("twelvedata", "user", now + 1, "finger-a")).toBe(true);
    expect(isPaidQuoteBreakerCooling("twelvedata", "user", now + 1, "finger-b")).toBe(false);
    expect(isPaidQuoteBreakerCooling("twelvedata", "env", now + 1, "finger-a")).toBe(false);
  });

  it("retries a paid-quote 429 when the breaker is disabled", async () => {
    const { apiCircuitBreakerShouldSkip, fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    const fetchMock = vi.fn(async () => new Response("slow", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://example.test/twelvedata", { cache: "no-store" }, {
      service: "twelvedata",
      keySource: "env",
      credentialId: "finger-a",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(apiCircuitBreakerShouldSkip("twelvedata", "env", "finger-a").skip).toBe(false);
  });

  it("treats a Twelve Data credit message as a quota signal and ignores a bad key", async () => {
    const { isTwelveDataCreditExhausted, isTwelveDataQuotaSignal, isTwelveDataRateLimitSignal } = await load();
    expect(isTwelveDataQuotaSignal("You have run out of API credits for the current minute")).toBe(true);
    expect(isTwelveDataCreditExhausted("You have run out of API credits for the current minute")).toBe(true);
    expect(isTwelveDataCreditExhausted("too many requests")).toBe(false);
    expect(isTwelveDataRateLimitSignal("too many requests")).toBe(true);
    expect(isTwelveDataQuotaSignal("Invalid API key")).toBe(false);
  });

  it("caps a paid-quote Retry-After at one hour", async () => {
    const { fetchWithRetry, listOpenApiCircuitBreakers, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow", { status: 429, headers: { "Retry-After": "86400" } })));
    const res = await fetchWithRetry("https://example.test/tiingo", { cache: "no-store" }, {
      service: "tiingo",
      keySource: "env",
      retries: 0,
      backoffMs: 1
    });
    expect(res.status).toBe(429);
    const open = listOpenApiCircuitBreakers().find((row) => row.service === "tiingo");
    expect(open?.openForMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(open?.openForMs).toBeGreaterThan(50 * 60 * 1000);
  });
});

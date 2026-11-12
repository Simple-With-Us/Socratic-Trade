import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalBreakerEnv = {
  API_CIRCUIT_BREAKER_DISABLED: process.env.API_CIRCUIT_BREAKER_DISABLED,
  QUOTE_PROVIDER_402_HOLD_MS: process.env.QUOTE_PROVIDER_402_HOLD_MS,
  QUOTE_PROVIDER_429_BASE_MS: process.env.QUOTE_PROVIDER_429_BASE_MS,
  QUOTE_PROVIDER_429_CAP_MS: process.env.QUOTE_PROVIDER_429_CAP_MS,
  QUOTE_PROVIDER_RETRY_AFTER_CAP_MS: process.env.QUOTE_PROVIDER_RETRY_AFTER_CAP_MS
};

function restoreBreakerEnv(): void {
  for (const [key, value] of Object.entries(originalBreakerEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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
    restoreBreakerEnv();
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
    const {
      isTwelveDataCreditExhausted,
      isTwelveDataQuotaSignal,
      isTwelveDataRateLimitSignal,
      listOpenApiCircuitBreakers,
      observePaidQuoteStatus,
      resetApiCircuitBreaker,
      twelveDataBodyHold
    } = await load();
    resetApiCircuitBreaker();
    const minute = "You have run out of API credits for the current minute";
    const day = "You have run out of API credits for the day";
    expect(isTwelveDataQuotaSignal(minute)).toBe(true);
    expect(isTwelveDataCreditExhausted(minute)).toBe(false);
    expect(isTwelveDataRateLimitSignal(minute)).toBe(true);
    expect(isTwelveDataCreditExhausted(day)).toBe(true);
    expect(isTwelveDataRateLimitSignal(day)).toBe(false);
    expect(isTwelveDataCreditExhausted("too many requests")).toBe(false);
    expect(isTwelveDataRateLimitSignal("too many requests")).toBe(true);
    expect(isTwelveDataQuotaSignal("Invalid API key")).toBe(false);

    const now = 1_700_000_000_000;
    const minuteHold = twelveDataBodyHold(minute);
    expect(minuteHold).toEqual({ status: 429, retryAfterMs: 60_000 });
    // A body-only 429 is not an HTTP Retry-After. Callers open the lane for a 402 only.
    expect(observePaidQuoteStatus("twelvedata", "env", 429, undefined, now, "finger-minute")).toBe(0);
    const dayHold = twelveDataBodyHold(day);
    expect(dayHold).toEqual({ status: 402 });
    expect(observePaidQuoteStatus("twelvedata", "user", dayHold!.status, dayHold!.retryAfterMs, now, "finger-day")).toBeGreaterThan(5 * 60 * 60 * 1000);
    const open = listOpenApiCircuitBreakers(now + 1);
    expect(open.find((row) => row.status === 429)).toBeUndefined();
    expect(open.find((row) => row.status === 402)?.openForMs).toBeGreaterThan(5 * 60 * 60 * 1000);
  });

  it("sees a plain-lane hold when the caller has a credential fingerprint", async () => {
    const { isPaidQuoteBreakerCooling, resetApiCircuitBreaker, tripApiCircuitBreakerLane } = await load();
    resetApiCircuitBreaker();
    const now = 1_700_000_000_000;
    tripApiCircuitBreakerLane("tiingo", "env", 60_000, now, { reason: "consecutive-failures" });
    expect(isPaidQuoteBreakerCooling("tiingo", "env", now + 1, "finger-a")).toBe(true);
    expect(isPaidQuoteBreakerCooling("tiingo", "user", now + 1, "finger-a")).toBe(false);
  });

  it("keeps a paid-provider 402 soft when the breaker is disabled", async () => {
    const { fetchWithRetry, getDb, listOpenApiCircuitBreakers, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no credit", { status: 402 })));
    const res = await fetchWithRetry("https://example.test/roic-disabled", { cache: "no-store" }, {
      service: "roic",
      keySource: "env",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(402);
    expect(listOpenApiCircuitBreakers()).toEqual([]);
    const row = getDb()
      .prepare(`SELECT error_text FROM api_health_log WHERE service = ? ORDER BY rowid DESC LIMIT 1`)
      .get("roic") as { error_text: string } | undefined;
    expect(row?.error_text.startsWith("[expected-limit] ")).toBe(true);
  });

  it("still opens a non-quote rate-limit hold when 429 is suppressed from health", async () => {
    const { apiCircuitBreakerShouldSkip, fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow", {
      status: 429,
      headers: { "Retry-After": "30" }
    })));
    const massive = await fetchWithRetry("https://example.test/massive", { cache: "no-store" }, {
      service: "massive",
      retries: 0,
      backoffMs: 1,
      suppressHealthStatuses: [404, 429]
    });
    expect(massive.status).toBe(429);
    expect(apiCircuitBreakerShouldSkip("massive", null).skip).toBe(true);

    resetApiCircuitBreaker();
    const roic = await fetchWithRetry("https://example.test/roic-plan", { cache: "no-store" }, {
      service: "roic",
      keySource: "env",
      retries: 0,
      backoffMs: 1,
      suppressHealthStatuses: [402, 404, 429]
    });
    expect(roic.status).toBe(429);
    expect(apiCircuitBreakerShouldSkip("roic", "env").skip).toBe(false);
  });

  it("caps the in-call 429 wait at the quote Retry-After ceiling", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    process.env.QUOTE_PROVIDER_RETRY_AFTER_CAP_MS = "30";
    const fetchMock = vi.fn(async () => new Response("slow", {
      status: 429,
      headers: { "Retry-After": "86400" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const res = await fetchWithRetry("https://example.test/tiingo-wait", { cache: "no-store" }, {
      service: "tiingo",
      keySource: "env",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("waits out a paid-quote Retry-After before the second attempt", async () => {
    const { apiCircuitBreakerShouldSkip, fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi.fn(async () => new Response("slow", {
      status: 429,
      headers: { "Retry-After": "2" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const pending = fetchWithRetry("https://example.test/tiingo-wait-control", { cache: "no-store" }, {
        service: "tiingo",
        keySource: "env",
        retries: 1,
        backoffMs: 1
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(apiCircuitBreakerShouldSkip("tiingo", "env").skip).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

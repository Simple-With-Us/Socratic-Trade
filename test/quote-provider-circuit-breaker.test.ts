import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-quote-breaker-${randomUUID()}.db`)}`;
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
  });

  it("holds a header-less 429 with exponential backoff and a 402 for hours", async () => {
    const { paidQuoteHoldMs, resetApiCircuitBreaker, quoteProvider402HoldMs } = await load();
    resetApiCircuitBreaker();
    expect(paidQuoteHoldMs("twelvedata", "env", 429, undefined)).toBe(1_000);
    expect(paidQuoteHoldMs("twelvedata", "env", 429, undefined)).toBe(2_000);
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
      const response = new Response("slow", { status: 429, headers: { "Retry-After": "30" } });
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(open[0].openForMs).toBeGreaterThan(20_000);

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

  it("uses exponential backoff when a paid quote 429 has no Retry-After", async () => {
    const { fetchWithRetry, listOpenApiCircuitBreakers, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow", { status: 429 })));

    const res = await fetchWithRetry("https://example.test/tiingo", { cache: "no-store" }, {
      service: "tiingo",
      keySource: "env",
      retries: 3,
      backoffMs: 1
    });
    expect(res.status).toBe(429);
    const open = listOpenApiCircuitBreakers().find((row) => row.service === "tiingo");
    expect(open?.reason).toBe("rate-limit");
    expect(open?.openForMs).toBeLessThan(5_000);
    expect(open?.openForMs).toBeGreaterThan(500);
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
});

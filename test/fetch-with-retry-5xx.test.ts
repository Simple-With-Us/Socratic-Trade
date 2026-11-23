import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-fetch-retry-5xx-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "c".repeat(64);
});

async function load() {
  const breaker = await import("../src/lib/api-circuit-breaker");
  const providers = await import("../src/lib/data-providers");
  const db = await import("../src/lib/db");
  return { ...breaker, ...providers, getDb: db.getDb };
}

describe("fetchWithRetry 5xx handling (ST-4661)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries a 500 once and succeeds on the following 200 with exactly two calls", async () => {
    const { fetchWithRetry, getDb, resetApiCircuitBreaker } = await load();
    getDb();
    resetApiCircuitBreaker();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/flaky-5xx", { cache: "no-store" }, {
      service: "fetch-retry-5xx-test",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the final 5xx Response to the caller when retries are exhausted", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi.fn(async () => new Response("still down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/down-5xx", { cache: "no-store" }, {
      service: "fetch-retry-5xx-exhausted",
      retries: 1,
      backoffMs: 1
    });
    // The caller contract survives: a 5xx Response object is still returned
    // (not thrown), exactly as before the retry existed.
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404 (4xx is never retried on status)", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/missing", { cache: "no-store" }, {
      service: "fetch-retry-404-test",
      retries: 2,
      backoffMs: 1
    });
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a non-idempotent POST on 5xx", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry(
      "https://example.test/write",
      { cache: "no-store", method: "POST", body: "{}" },
      { service: "fetch-retry-post-test", retries: 2, backoffMs: 1 }
    );
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps thrown transient-error retry behavior unchanged", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("recovered", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/dead-socket", { cache: "no-store" }, {
      service: "fetch-retry-thrown-test",
      retries: 1,
      backoffMs: 1
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a caller signal that aborts during 429 backoff", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        fetchWithRetry(
          "https://example.test/backoff-abort",
          { cache: "no-store", signal: controller.signal },
          { service: "fetch-retry-backoff-abort-test", retries: 1, backoffMs: 60_000 }
        )
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a caller timeout abort and does not retry on the dead signal", async () => {
    const { fetchWithRetry, resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // never settles without a signal; the abort below settles it
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        fetchWithRetry(
          "https://example.test/slow-timeout",
          { cache: "no-store", signal: controller.signal },
          { service: "fetch-retry-timeout-test", retries: 2, backoffMs: 1 }
        )
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

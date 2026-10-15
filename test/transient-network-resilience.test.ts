import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const dir = mkdtempSync(join(tmpdir(), "agentic-transient-net-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

describe("transient network classifiers", () => {
  it("treats dead keep-alive sockets as retryable and caller aborts as not", async () => {
    const { isAbortOrTimeoutError, isTransientNetworkError } = await import("../src/lib/network-errors");

    const socket = new TypeError("fetch failed");
    (socket as Error & { cause?: Error }).cause = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET"
    });
    expect(isTransientNetworkError(socket)).toBe(true);
    expect(isAbortOrTimeoutError(socket)).toBe(false);

    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isAbortOrTimeoutError(abort)).toBe(true);
    expect(isTransientNetworkError(abort)).toBe(false);
  });

  it("classifies budget aborts as soft health and socket deaths as hard", async () => {
    const { isSoftHealthFailure } = await import("../src/lib/db-health");
    expect(isSoftHealthFailure("This operation was aborted")).toBe(true);
    expect(isSoftHealthFailure("AbortError: The operation was aborted")).toBe(true);
    expect(isSoftHealthFailure("fetch failed")).toBe(false);
    expect(isSoftHealthFailure("other side closed")).toBe(false);
  });
});

describe("fetchWithRetry retries a dead socket then succeeds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not write a failure health row for a recovered transport blip", async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    const { fetchWithRetry } = await import("../src/lib/data-providers");

    const socket = new TypeError("fetch failed");
    (socket as Error & { cause?: Error }).cause = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET"
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(socket)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://example.test/quote", { cache: "no-store" }, {
      service: "alpaca-snapshot",
      retries: 1,
      backoffMs: 1
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const row = getDb()
      .prepare(`SELECT ok, error_text FROM api_health_log WHERE service = ? ORDER BY rowid DESC LIMIT 1`)
      .get("alpaca-snapshot") as { ok: number; error_text: string | null } | undefined;
    expect(row?.ok).toBe(1);
  });

  it("does not retry a caller abort", async () => {
    const { fetchWithRetry } = await import("../src/lib/data-providers");
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const fetchMock = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithRetry("https://example.test/calendar", { signal: controller.signal }, {
        service: "nasdaq-calendar",
        retries: 1,
        backoffMs: 1
      })
    ).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 before opening the lane, and only for a positive Retry-After", async () => {
    // maxWorkers is 1, so an earlier file can leave the breaker disabled for the
    // rest of the process.  This case has to see the real hold.
    const previousDisabled = process.env.API_CIRCUIT_BREAKER_DISABLED;
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    try {
      const { getDb } = await import("../src/lib/db");
      getDb();
      const { fetchWithRetry } = await import("../src/lib/data-providers");
      const { apiCircuitBreakerShouldSkip, resetApiCircuitBreaker } = await import("../src/lib/api-circuit-breaker");
      resetApiCircuitBreaker();
      let calls = 0;
      let openAtRetry = true;
      vi.stubGlobal("fetch", async () => {
        calls += 1;
        if (calls === 2) {
          openAtRetry = apiCircuitBreakerShouldSkip("retry-429-lane", null).skip;
          return new Response("slow", { status: 429, headers: { "Retry-After": "30" } });
        }
        return new Response("slow", { status: 429 });
      });

      const res = await fetchWithRetry("https://example.test/retry-429", { cache: "no-store" }, {
        service: "retry-429-lane",
        retries: 1,
        backoffMs: 1
      });
      expect(res.status).toBe(429);
      expect(calls).toBe(2);
      expect(openAtRetry).toBe(false);
      expect(apiCircuitBreakerShouldSkip("retry-429-lane", null).skip).toBe(true);

      resetApiCircuitBreaker();
      calls = 0;
      vi.stubGlobal("fetch", async () => {
        calls += 1;
        return new Response("slow", { status: 429 });
      });
      const plain = await fetchWithRetry("https://example.test/retry-429-plain", { cache: "no-store" }, {
        service: "retry-429-plain",
        retries: 1,
        backoffMs: 1
      });
      expect(plain.status).toBe(429);
      expect(calls).toBe(2);
      expect(apiCircuitBreakerShouldSkip("retry-429-plain", null).skip).toBe(false);
    } finally {
      if (previousDisabled === undefined) delete process.env.API_CIRCUIT_BREAKER_DISABLED;
      else process.env.API_CIRCUIT_BREAKER_DISABLED = previousDisabled;
    }
  });
});

describe("broker health does not auto-halt on the first socket blip", () => {
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
  });

  beforeEach(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().exec("DELETE FROM settings; DELETE FROM audit_events;");
  });

  it("skips three transient connectivity failures before halting, then resumes", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      getBrokerPlacementPauseMarker,
      BROKER_CONNECTIVITY_HALT_STREAK
    } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = `acct-socket-${randomUUID()}`;
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const blip = {
      isHealthy: false as const,
      reason: "Broker connectivity failure: fetch failed",
      category: "connectivity" as const
    };

    for (let i = 1; i < BROKER_CONNECTIVITY_HALT_STREAK; i++) {
      const skipped = await applyBrokerOrderPlacementPause({
        userId,
        accountScope,
        health: blip,
        policy
      });
      expect(skipped.action).toBe("none");
      expect(getPolicy(userId).systemState).toBe("active");
      expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    }

    const halted = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: blip,
      policy
    });
    expect(halted.action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");

    policy.systemState = "halted";
    const resumed = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(resumed.action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("still auto-halts immediately on a real order-path outage", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = `acct-oms-${randomUUID()}`;
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const halt = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: {
        isHealthy: false,
        reason: "Broker reports orders cannot be placed",
        category: "order_capability"
      },
      policy
    });
    expect(halt.action).toBe("halted");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginEmbedProviderAttempt,
  countsTowardEmbedProviderFailure,
  createEmbedAttemptAbort,
  settleEmbedProviderAttempt,
  getCachedContentEmbedding,
  isEmbedBreakerOpen,
  noteEmbedProviderFailure,
  noteEmbedProviderSuccess,
  resetEmbedResilienceForTests,
  setCachedContentEmbedding
} from "../src/lib/rag/embed-resilience";

describe("search-fusion embedding response schema", () => {
  it("rejects malformed embedding vectors at the HTTP boundary", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-schema");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ embedding: ["not-a-number"] }] }), { status: 200 })
      )
    );
    const { fetchAlternativeEmbedding } = await import("../src/lib/rag/search-fusion");
    await expect(fetchAlternativeEmbedding(["hello"], "local")).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("embed circuit breaker", () => {
  beforeEach(() => {
    resetEmbedResilienceForTests();
    process.env.EMBED_CIRCUIT_BREAKER = "on";
    process.env.EMBED_BREAKER_FAILURES = "3";
    process.env.EMBED_BREAKER_COOLDOWN_MS = "60000";
  });
  afterEach(() => {
    resetEmbedResilienceForTests();
    delete process.env.EMBED_CIRCUIT_BREAKER;
    delete process.env.EMBED_BREAKER_FAILURES;
    delete process.env.EMBED_BREAKER_COOLDOWN_MS;
    delete process.env.EMBED_CONTENT_CACHE_MAX;
    delete process.env.EMBED_CONTENT_CACHE_TTL_MS;
    vi.restoreAllMocks();
  });

  it("opens after N consecutive failures, warns once, and then refuses calls", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(beginEmbedProviderAttempt("openrouter", 1_000)).toBe(true);
    noteEmbedProviderFailure("openrouter", 1_000);
    noteEmbedProviderFailure("openrouter", 1_000);
    expect(beginEmbedProviderAttempt("openrouter", 1_000)).toBe(true);
    noteEmbedProviderFailure("openrouter", 1_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("embed circuit open for openrouter");
    expect(beginEmbedProviderAttempt("openrouter", 1_000)).toBe(false);
    expect(beginEmbedProviderAttempt("openrouter", 1_500)).toBe(false);
    noteEmbedProviderFailure("openrouter", 1_500);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allows one half-open probe after the cooldown and a success closes the breaker", () => {
    process.env.EMBED_BREAKER_FAILURES = "1";
    process.env.EMBED_BREAKER_COOLDOWN_MS = "50";
    noteEmbedProviderFailure("openrouter", 1_000);
    expect(beginEmbedProviderAttempt("openrouter", 1_020)).toBe(false);
    expect(beginEmbedProviderAttempt("openrouter", 1_050)).toBe(true);
    expect(beginEmbedProviderAttempt("openrouter", 1_051)).toBe(false);
    noteEmbedProviderSuccess("openrouter");
    expect(beginEmbedProviderAttempt("openrouter", 1_080)).toBe(true);
    expect(beginEmbedProviderAttempt("siliconflow", 1_080)).toBe(true);
  });

  it("serves a content-hash hit while the breaker is open and misses on different text or model", () => {
    process.env.EMBED_BREAKER_FAILURES = "1";
    setCachedContentEmbedding("baai/bge-m3", 1, "query", "hello world", [0.25, 0.5]);
    noteEmbedProviderFailure("openrouter", 5_000);
    expect(beginEmbedProviderAttempt("openrouter", 5_000)).toBe(false);
    const hit = getCachedContentEmbedding("baai/bge-m3", 1, "query", "hello world");
    expect(hit).toEqual([0.25, 0.5]);
    if (hit) hit[0] = 9;
    expect(getCachedContentEmbedding("baai/bge-m3", 1, "query", "hello world")).toEqual([0.25, 0.5]);
    expect(getCachedContentEmbedding("baai/bge-m3", 1, "query", "other text")).toBeUndefined();
    expect(getCachedContentEmbedding("other-model", 1, "query", "hello world")).toBeUndefined();
    expect(getCachedContentEmbedding("baai/bge-m3", 2, "query", "hello world")).toBeUndefined();
  });

  it("releases a half-open probe on non-counted 4xx without wedging the breaker", () => {
    process.env.EMBED_BREAKER_FAILURES = "1";
    process.env.EMBED_BREAKER_COOLDOWN_MS = "50";
    noteEmbedProviderFailure("openrouter", 1_000);
    expect(beginEmbedProviderAttempt("openrouter", 1_060)).toBe(true);
    expect(beginEmbedProviderAttempt("openrouter", 1_061)).toBe(false);
    const clientError = Object.assign(new Error("bad request"), { status: 400 });
    settleEmbedProviderAttempt("openrouter", clientError, 1_061);
    expect(beginEmbedProviderAttempt("openrouter", 1_062)).toBe(true);

    resetEmbedResilienceForTests();
    process.env.EMBED_BREAKER_FAILURES = "2";
    noteEmbedProviderFailure("openrouter", 1_000);
    noteEmbedProviderFailure("openrouter", 1_001);
    expect(beginEmbedProviderAttempt("openrouter", 1_060)).toBe(true);
    settleEmbedProviderAttempt("openrouter", clientError, 1_060);
    noteEmbedProviderFailure("openrouter", 1_061);
    expect(isEmbedBreakerOpen("openrouter", 1_061)).toBe(false);
    expect(beginEmbedProviderAttempt("openrouter", 1_062)).toBe(true);
  });

  it("does not re-warn when a half-open probe fails after the cooldown", () => {
    process.env.EMBED_BREAKER_FAILURES = "1";
    process.env.EMBED_BREAKER_COOLDOWN_MS = "50";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    noteEmbedProviderFailure("openrouter", 1_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(beginEmbedProviderAttempt("openrouter", 1_060)).toBe(true);
    noteEmbedProviderFailure("openrouter", 1_060);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("classifies provider failures for the circuit breaker", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(countsTowardEmbedProviderFailure(abort)).toBe(false);
    const client = Object.assign(new Error("bad request"), { status: 400 });
    expect(countsTowardEmbedProviderFailure(client)).toBe(false);
    const server = Object.assign(new Error("boom"), { status: 503 });
    expect(countsTowardEmbedProviderFailure(server)).toBe(true);
    const timeout = new Error("embed provider timed out");
    timeout.name = "TimeoutError";
    expect(countsTowardEmbedProviderFailure(timeout)).toBe(true);
  });

  it("drops poisoned cache entries instead of serving them", () => {
    setCachedContentEmbedding("baai/bge-m3", 1, "query", "bad", [Number.NaN, 1]);
    expect(getCachedContentEmbedding("baai/bge-m3", 1, "query", "bad")).toBeUndefined();
    setCachedContentEmbedding("baai/bge-m3", 1, "query", "good", [0.1, 0.2]);
    expect(getCachedContentEmbedding("baai/bge-m3", 1, "query", "good")).toEqual([0.1, 0.2]);
  });

  it("aborts an embed attempt with TimeoutError", async () => {
    const attempt = createEmbedAttemptAbort(undefined, 15);
    const reason = await new Promise<unknown>((resolve) => {
      attempt.signal.addEventListener("abort", () => resolve(attempt.signal.reason), { once: true });
    });
    attempt.cancel();
    expect(reason).toBeInstanceOf(Error);
    expect(reason).toMatchObject({ name: "TimeoutError", message: "embed provider timed out" });
  });
});

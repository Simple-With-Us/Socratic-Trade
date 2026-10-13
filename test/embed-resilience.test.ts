import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginEmbedProviderAttempt,
  createEmbedAttemptAbort,
  getCachedContentEmbedding,
  noteEmbedProviderFailure,
  noteEmbedProviderSuccess,
  resetEmbedResilienceForTests,
  setCachedContentEmbedding
} from "../src/lib/rag/embed-resilience";

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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOpenRouterUserModelAvailabilityCache,
  getOpenRouterUserModelAvailability,
  isOpenRouterModelAvailable
} from "../src/lib/openrouter-model-availability";

describe("OpenRouter account model availability", () => {
  afterEach(() => {
    clearOpenRouterUserModelAvailabilityCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the account-filtered model IDs and normalizes catalog names", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.6-sol" }, { id: "deepseek/deepseek-v4-pro" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOpenRouterUserModelAvailability("test-key", "key-ref");

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(isOpenRouterModelAvailable("gpt-5.6-sol", result.modelIds)).toBe(true);
    expect(isOpenRouterModelAvailable("deepseek-v4-pro", result.modelIds)).toBe(true);
    expect(isOpenRouterModelAvailable("claude-fable-5", result.modelIds)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/models/user");
  });

  it("matches alias/version pairs when /models/user lists versioned ids, not *-latest", () => {
    const versioned = new Set([
      "anthropic/claude-haiku-4.5",
      "google/gemini-3.7-flash",
      "mistralai/mistral-small-2603",
      "x-ai/grok-4.5",
      "openai/gpt-5.4-mini",
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.6-terra"
    ]);
    expect(isOpenRouterModelAvailable("claude-haiku-4.5", versioned)).toBe(true);
    expect(isOpenRouterModelAvailable("gemini-flash-latest", versioned)).toBe(true);
    expect(isOpenRouterModelAvailable("mistral-small-latest", versioned)).toBe(true);
    expect(isOpenRouterModelAvailable("grok-4.5", versioned)).toBe(true);
    expect(isOpenRouterModelAvailable("gpt-5.4-mini", versioned)).toBe(true);
    expect(isOpenRouterModelAvailable("claude-sonnet-5", versioned)).toBe(true);
    expect(isOpenRouterModelAvailable("claude-fable-5", versioned)).toBe(false);
    expect(isOpenRouterModelAvailable("kimi-latest", versioned)).toBe(false);
  });

  it("does not treat a listed retired minimax/minimax-m3 row as proof M3.1 Flash is servable", () => {
    const legacyOnly = new Set(["minimax/minimax-m3"]);
    expect(isOpenRouterModelAvailable("minimax-m3.1-flash", legacyOnly)).toBe(false);
    expect(isOpenRouterModelAvailable("minimax/minimax-m3.1-flash", legacyOnly)).toBe(false);
    expect(isOpenRouterModelAvailable("minimax-m3", legacyOnly)).toBe(true);
  });

  it("treats OpenRouter ~ latest aliases as the same class as dated public ids", () => {
    const listed = new Set([
      "~anthropic/claude-sonnet-latest",
      "~anthropic/claude-haiku-latest",
      "~x-ai/grok-latest",
      "~openai/gpt-mini-latest",
      "~moonshotai/kimi-latest",
      "deepseek/deepseek-r1"
    ]);
    expect(isOpenRouterModelAvailable("claude-sonnet-5", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("anthropic/claude-sonnet-latest", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("claude-haiku-4.5", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("grok-4.5", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("gpt-5.4-mini", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("kimi-latest", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("deepseek-reasoner", listed)).toBe(true);
    expect(isOpenRouterModelAvailable("claude-fable-5", listed)).toBe(false);
  });

  it("fails closed when the availability endpoint is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    await expect(getOpenRouterUserModelAvailability("test-key", "key-ref")).resolves.toEqual({
      status: "unavailable",
      reason: "http_503"
    });
  });

  it("reuses a stale cache after a later 429 instead of emptying rotation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.6-sol" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getOpenRouterUserModelAvailability("test-key", "stale-ref");
    expect(first.status).toBe("available");
    vi.advanceTimersByTime(6 * 60 * 1000);
    const second = await getOpenRouterUserModelAvailability("test-key", "stale-ref");
    expect(second.status).toBe("available");
    if (second.status === "available") {
      expect(isOpenRouterModelAvailable("gpt-5.6-sol", second.modelIds)).toBe(true);
    }
    vi.useRealTimers();
  });
});

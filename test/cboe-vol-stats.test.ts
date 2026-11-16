import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCboeVolStats } from "../src/lib/market-signals/cboe";

function mockCboeQuote(symbol: string, price: number) {
  return {
    ok: true,
    json: async () => ({ data: { current_price: price }, symbol: `_${symbol}` })
  };
}

describe("fetchCboeVolStats", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches SKEW, VVIX, and VIX9D concurrently and returns all three", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("_SKEW")) return mockCboeQuote("SKEW", 128.4);
        if (url.includes("_VVIX")) return mockCboeQuote("VVIX", 96.2);
        if (url.includes("_VIX9D")) return mockCboeQuote("VIX9D", 13.05);
        throw new Error(`unexpected url: ${url}`);
      })
    );

    const stats = await fetchCboeVolStats();
    expect(stats.skew).toBe(128.4);
    expect(stats.vvix).toBe(96.2);
    expect(stats.vix9d).toBe(13.05);
    expect(stats.asOf).toBe(new Date().toISOString().split("T")[0]);
  });

  it("omits vix9d (never fabricates) when only that lane fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("_SKEW")) return mockCboeQuote("SKEW", 120);
        if (url.includes("_VVIX")) return mockCboeQuote("VVIX", 90);
        if (url.includes("_VIX9D")) return { ok: false };
        throw new Error(`unexpected url: ${url}`);
      })
    );

    const stats = await fetchCboeVolStats();
    expect(stats.skew).toBe(120);
    expect(stats.vvix).toBe(90);
    expect("vix9d" in stats).toBe(false);
  });

  it("returns an empty object with no asOf when every lane fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const stats = await fetchCboeVolStats();
    expect(stats).toEqual({});
  });
});

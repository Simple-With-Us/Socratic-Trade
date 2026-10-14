import { describe, expect, it } from "vitest";
import {
  clearProviderFieldCacheForTests,
  readProviderFieldCache,
  readProviderFieldCacheForSymbol,
  writeProviderFieldCache
} from "../src/lib/provider-field-cache";

describe("provider-field-cache", () => {
  it("round-trips a symbol+field value until TTL expires", () => {
    clearProviderFieldCacheForTests();
    const now = 1_000_000;
    writeProviderFieldCache("finnhub", "AAPL", "peRatio", 28.5, 60_000, now);
    expect(readProviderFieldCache<number>("finnhub", "AAPL", "peRatio", now + 30_000)).toBe(28.5);
    expect(readProviderFieldCache("finnhub", "AAPL", "peRatio", now + 61_000)).toBeUndefined();
  });

  it("readProviderFieldCacheForSymbol returns the newest lane hit for a field", () => {
    clearProviderFieldCacheForTests();
    const now = 2_000_000;
    writeProviderFieldCache("yahoo-finance", "MSFT", "price", 400, 60_000, now);
    writeProviderFieldCache("finnhub", "MSFT", "price", 401, 120_000, now);
    const hit = readProviderFieldCacheForSymbol<number>("MSFT", "price", now);
    expect(hit?.provider).toBe("finnhub");
    expect(hit?.value).toBe(401);
  });
});

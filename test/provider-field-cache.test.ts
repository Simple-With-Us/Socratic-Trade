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

  it("keeps the longer-lived lane when a later write expires sooner", () => {
    clearProviderFieldCacheForTests();
    const now = 3_000_000;
    writeProviderFieldCache("yahoo-finance", "MSFT", "price", 400, 120_000, now);
    writeProviderFieldCache("finnhub", "MSFT", "price", 401, 60_000, now);
    const hit = readProviderFieldCacheForSymbol<number>("MSFT", "price", now);
    expect(hit?.provider).toBe("yahoo-finance");
    expect(hit?.value).toBe(400);
  });

  it("drops the oldest entries once the map passes 50k", () => {
    clearProviderFieldCacheForTests();
    const now = 4_000_000;
    for (let i = 0; i < 50_001; i++) {
      writeProviderFieldCache("p", `S${i}`, "peRatio", i, 60_000, now);
    }
    expect(readProviderFieldCache("p", "S0", "peRatio", now)).toBeUndefined();
    expect(readProviderFieldCache<number>("p", "S50000", "peRatio", now)).toBe(50_000);
    expect(readProviderFieldCacheForSymbol<number>("S50000", "peRatio", now)?.value).toBe(50_000);
  });
});

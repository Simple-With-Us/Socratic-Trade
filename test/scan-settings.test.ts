import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  MAX_MARKET_SCAN_CANDIDATE_LIMIT,
  MIN_MARKET_SCAN_CANDIDATE_LIMIT,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "../src/lib/scan-settings";

describe("market scan setting bounds", () => {
  it("keeps the candidate limit inside the expert guardrails", () => {
    expect(normalizeMarketScanCandidateLimit(undefined)).toBe(DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT);
    expect(normalizeMarketScanCandidateLimit(1)).toBe(MIN_MARKET_SCAN_CANDIDATE_LIMIT);
    expect(normalizeMarketScanCandidateLimit(10_000)).toBe(MAX_MARKET_SCAN_CANDIDATE_LIMIT);
    expect(normalizeMarketScanCandidateLimit(42.4)).toBe(42);
  });

  it("keeps the outlier reserve inside the candidate cap", () => {
    expect(normalizeMarketScanOutlierReserve(undefined, 30)).toBe(DEFAULT_MARKET_SCAN_OUTLIER_RESERVE);
    expect(normalizeMarketScanOutlierReserve(-1, 30)).toBe(0);
    expect(normalizeMarketScanOutlierReserve(50, 12)).toBe(12);
    expect(normalizeMarketScanOutlierReserve(50, 100)).toBe(25);
  });
});

import { describe, expect, it } from "vitest";
import {
  directVendorRetirementMessage,
  intentionalOffHealthReason,
  isDirectVendorAccessAllowed,
  isIntentionalOffHealthService,
  isRetiredDirectVendorUrl,
  RETIRED_DIRECT_VENDORS
} from "../src/lib/retired-direct-vendors";

describe("retired direct vendors policy", () => {
  it("bans FMP, QuiverQuant, and Unusual Whales with no override", () => {
    expect(RETIRED_DIRECT_VENDORS).toEqual(["fmp", "quiverquant", "unusual_whales"]);
    for (const vendor of RETIRED_DIRECT_VENDORS) {
      expect(isDirectVendorAccessAllowed(vendor)).toBe(false);
      expect(directVendorRetirementMessage(vendor)).toMatch(/Congress\.Trade/);
    }
  });

  it("flags known vendor host URLs", () => {
    expect(isRetiredDirectVendorUrl("https://financialmodelingprep.com/stable/profile")).toBe(true);
    expect(isRetiredDirectVendorUrl("https://api.quiverquant.com/beta/historical/congresstrading/AAPL")).toBe(true);
    expect(isRetiredDirectVendorUrl("https://api.unusualwhales.com/api/congress/recent-trades")).toBe(true);
    expect(isRetiredDirectVendorUrl("https://congress.trade/api/transactions")).toBe(false);
    expect(isRetiredDirectVendorUrl("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")).toBe(false);
  });

  it("marks FMP variants and Quiver as intentional OFF health lanes", () => {
    for (const service of [
      "fmp",
      "fmp-rapidapi",
      "fmp-earnings-transcript",
      "fmp_transcripts",
      "quiverquant",
      "quiver",
      "unusual_whales",
      "unusual-whales"
    ]) {
      expect(isIntentionalOffHealthService(service)).toBe(true);
      expect(intentionalOffHealthReason(service).length).toBeGreaterThan(10);
    }
    expect(isIntentionalOffHealthService("finnhub")).toBe(false);
    expect(isIntentionalOffHealthService("congress.trade")).toBe(false);
    expect(isIntentionalOffHealthService("massive")).toBe(false);
  });
});

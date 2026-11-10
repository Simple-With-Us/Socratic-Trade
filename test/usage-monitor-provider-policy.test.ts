import { describe, expect, it } from "vitest";
import { suppressUsageMonitorProvider } from "../src/lib/usage-monitor-provider-policy";

describe("Usage Monitor provider policy", () => {
  it.each([
    "alpaca",
    "alpaca-news",
    "alpaca-snapshot",
    "alpaca-quotes",
    "robinhood",
    "robinhood-fundamentals",
    "tradier",
    "tradier-history",
    " ALPACA-NEWS ",
  ])("suppresses the retired provider family %s", (provider) => {
    expect(suppressUsageMonitorProvider(provider)).toBe(true);
  });

  it.each(["fmp", "finnhub", "massive", "openrouter", "voyage"])(
    "keeps paid provider %s eligible",
    (provider) => {
      expect(suppressUsageMonitorProvider(provider)).toBe(false);
    }
  );
});

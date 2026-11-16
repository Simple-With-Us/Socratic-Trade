import { describe, expect, it } from "vitest";
import { mergeAccountCapabilities } from "../src/lib/venue-contract-pure";
import type { AccountCapabilities } from "../src/lib/types";

function caps(over: Partial<AccountCapabilities>): AccountCapabilities {
  return {
    equityTrading: true,
    shortSelling: false,
    optionsTrading: false,
    futuresTrading: false,
    cryptoTrading: false,
    marginEnabled: false,
    accountType: "brokerage",
    ...over
  };
}

describe("venue-contract-pure client boundary", () => {
  it("loads without server DB dependencies and matches Tradier limits", () => {
    const merged = mergeAccountCapabilities("tradier", caps({ shortSelling: true, marginEnabled: true }));
    expect(merged.fractional).toBe(false);
    expect(merged.minShareQuantity).toBe(1);
    expect(merged.trailingStops).toBe(false);
    expect(merged.optionsOrders).toBe(false);
    expect(merged.nativeBrackets).toBe(true);
  });

  it("never promotes shorts when the venue profile forbids them", () => {
    const merged = mergeAccountCapabilities("robinhood", caps({ shortSelling: true }));
    expect(merged.shortSelling).toBe(false);
  });
});

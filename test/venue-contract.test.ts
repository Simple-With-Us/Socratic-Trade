import { describe, expect, it } from "vitest";
import { deriveVenueContract, mergeAccountCapabilities } from "../src/lib/venue-contract";
import { allowedProposalSides } from "../src/lib/strategy-risk";
import type { AccountCapabilities, TradingPolicy } from "../src/lib/types";
import { DEFAULT_POLICY } from "../src/lib/defaults";

function policy(over: Partial<TradingPolicy> = {}): TradingPolicy {
  return { ...DEFAULT_POLICY, ...over };
}

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

describe("venue contract", () => {
  it("keeps Robinhood long-only even when policy wants shorts", () => {
    const contract = deriveVenueContract(policy({ shortSellingEnabled: true }), {
      broker: "robinhood",
      capabilities: caps({ shortSelling: false })
    });
    expect(contract.sides).toEqual(["buy", "sell"]);
    expect(contract.optionsOrders).toBe(false);
    expect(contract.promptLines.some((line) => line.includes("SHORT SELLING IS DISABLED"))).toBe(true);
    expect(contract.promptLines.some((line) => line.includes("OPTIONS ORDERS ARE NOT AVAILABLE"))).toBe(true);
  });

  it("parks Public execution until PUBLIC_EXECUTION_ENABLED is on", () => {
    delete process.env.PUBLIC_EXECUTION_ENABLED;
    const parked = deriveVenueContract(policy({ shortSellingEnabled: true }), {
      broker: "public",
      capabilities: caps({ shortSelling: true })
    });
    expect(parked.sides).toEqual([]);
    expect(parked.promptLines.some((line) => /parked/i.test(line))).toBe(true);
  });

  it("allows Public shorts only when execution is on and policy also enables them", () => {
    process.env.PUBLIC_EXECUTION_ENABLED = "on";
    const off = deriveVenueContract(policy({ shortSellingEnabled: false }), {
      broker: "public",
      capabilities: caps({ shortSelling: true })
    });
    expect(off.sides).toEqual(["buy", "sell"]);
    const on = deriveVenueContract(policy({ shortSellingEnabled: true }), {
      broker: "public",
      capabilities: caps({ shortSelling: true })
    });
    expect(on.sides).toEqual(["buy", "sell", "short", "cover"]);
    delete process.env.PUBLIC_EXECUTION_ENABLED;
  });

  it("never promotes eToro shorts from a stale stored true", () => {
    const contract = deriveVenueContract(policy({ shortSellingEnabled: true }), {
      broker: "etoro",
      capabilities: caps({ shortSelling: true })
    });
    expect(contract.sides).toEqual(["buy", "sell"]);
    expect(contract.positionIdCloses).toBe(true);
    expect(contract.marketHours).toEqual(["regular_hours"]);
  });

  it("Tradier is whole-share, no trail, no option orders", () => {
    const contract = deriveVenueContract(policy(), {
      broker: "tradier",
      capabilities: caps({ shortSelling: true, marginEnabled: true })
    });
    expect(contract.fractional).toBe(false);
    expect(contract.minShareQuantity).toBe(1);
    expect(contract.trailingStops).toBe(false);
    expect(contract.optionsOrders).toBe(false);
    expect(contract.nativeBrackets).toBe(true);
  });

  it("Alpaca live shorting_enabled is respected; options stay unlistable", () => {
    const merged = mergeAccountCapabilities("alpaca", caps({ shortSelling: true }));
    expect(merged.shortSelling).toBe(true);
    expect(merged.optionsOrders).toBe(false);
    expect(merged.trailingStops).toBe(true);
    expect(merged.nativeBrackets).toBe(true);
    const noShort = mergeAccountCapabilities("alpaca", caps({ shortSelling: false }));
    expect(noShort.shortSelling).toBe(false);
  });

  it("Webull profile includes shorts and trail but not option orders on this path", () => {
    const contract = deriveVenueContract(policy({ shortSellingEnabled: true }), {
      broker: "webull",
      capabilities: mergeAccountCapabilities("webull")
    });
    expect(contract.sides).toContain("short");
    expect(contract.trailingStops).toBe(true);
    expect(contract.optionsOrders).toBe(false);
  });

  it("allowedProposalSides matches the contract", () => {
    expect(
      allowedProposalSides(policy({ shortSellingEnabled: true }), {
        id: "1",
        broker: "robinhood",
        environment: "live",
        accountNumber: "A",
        label: "x",
        capabilities: caps({ shortSelling: false })
      })
    ).toEqual(["buy", "sell"]);
  });
});

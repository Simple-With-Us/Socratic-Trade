import { describe, expect, it } from "vitest";
import { classifyAlpacaAccountType } from "../src/lib/alpaca";

describe("classifyAlpacaAccountType", () => {
  it("classifies regular cash or margin trading accounts as brokerage", () => {
    expect(classifyAlpacaAccountType({ account_type: "CASH" })).toBe("brokerage");
    expect(classifyAlpacaAccountType({ account_type: "MARGIN" })).toBe("brokerage");
  });

  it("classifies IRA account subtypes when Alpaca returns them", () => {
    expect(classifyAlpacaAccountType({ account_type: "ira", account_sub_type: "roth" })).toBe("roth_ira");
    expect(classifyAlpacaAccountType({ account_type: "ira", account_sub_type: "traditional" })).toBe("traditional_ira");
  });
});

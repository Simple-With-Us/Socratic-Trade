import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { mergePolicy } from "../src/lib/db-profiles";

describe("FMP module policy defaults", () => {
  it("defaults FMP product modules to off", () => {
    expect(DEFAULT_POLICY.fmpRealTimeDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpMacroDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpEventsDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpFundamentalsDataEnabled).toBe(false);
  });

  it("preserves user-selected FMP module toggles on merge (no hard coerce)", () => {
    // Owner 2026-08-06: toggles are selectable again; network still hard-blocked elsewhere.
    const merged = mergePolicy({
      fmpRealTimeDataEnabled: true,
      fmpMacroDataEnabled: true,
      fmpEventsDataEnabled: true,
      fmpFundamentalsDataEnabled: true
    });
    expect(merged.fmpRealTimeDataEnabled).toBe(true);
    expect(merged.fmpMacroDataEnabled).toBe(true);
    expect(merged.fmpEventsDataEnabled).toBe(true);
    expect(merged.fmpFundamentalsDataEnabled).toBe(true);
  });
});

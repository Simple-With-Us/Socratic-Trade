import { describe, expect, it } from "vitest";
import { GUARDRAILS_ESSENTIALS, SETTINGS_FIELDS } from "../app/settings-search";

describe("guardrails essentials (PR #3)", () => {
  it("opens on exactly five Essentials", () => {
    expect(GUARDRAILS_ESSENTIALS).toHaveLength(5);
  });

  it("binds the five Essentials to the expected fields, in order", () => {
    expect(GUARDRAILS_ESSENTIALS.map((f) => f.backingField)).toEqual([
      "maxOrderNotional",
      "riskRules.maxDailyLossNotional",
      "riskRules.stopLossPct",
      "strategyAuthority",
      "permitExtendedHours"
    ]);
  });

  it("binds 'Max order size (per trade)' to maxOrderNotional and never says 'position' (gap #4)", () => {
    const maxOrder = GUARDRAILS_ESSENTIALS.find((f) => f.id === "guardrails.maxOrderSize");
    expect(maxOrder?.label).toBe("Max order size (per trade)");
    expect(maxOrder?.backingField).toBe("maxOrderNotional");
    // The per-symbol total-holding cap is a different field, not this one.
    expect(maxOrder?.label.toLowerCase()).not.toContain("position");
    expect((maxOrder?.help ?? "").toLowerCase()).not.toContain("position");
    // maxOrderNotional backs exactly this one Essentials control.
    const backedByMaxOrder = SETTINGS_FIELDS.filter((f) => f.backingField === "maxOrderNotional");
    expect(backedByMaxOrder.map((f) => f.id)).toEqual(["guardrails.maxOrderSize"]);
  });

  it("keeps the true per-symbol holding cap as a separate Advanced field", () => {
    const perSymbol = SETTINGS_FIELDS.find((f) => f.id === "guardrails.perSymbolCap");
    expect(perSymbol?.disclosure).toBe("advanced");
    expect(perSymbol?.backingField).toBe("maxSymbolExposurePct");
  });

  it("every Essential is account-scoped and lives under the guardrails destination", () => {
    for (const f of GUARDRAILS_ESSENTIALS) {
      expect(f.scope).toBe("account");
      expect(f.destination).toBe("guardrails");
    }
  });
});

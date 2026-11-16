import { describe, expect, it } from "vitest";
import { SETTINGS_FIELDS, scopeMatchesLegacyTier } from "../app/settings-search";
import { settingsTierForSection } from "../app/settings-scope";

describe("settings tree scope (PR #3)", () => {
  it("has no field whose declared scope contradicts its legacy section's tier", () => {
    // Cross-check against settings-scope (the tier SSOT): a field tagged
    // account-scope must not sit under a user-tier legacy section, and vice versa.
    for (const field of SETTINGS_FIELDS) {
      expect(scopeMatchesLegacyTier(field)).toBe(true);
      if (field.legacySection) {
        expect(field.scope).toBe(settingsTierForSection(field.legacySection));
      }
    }
  });

  it("routes account-scope fields to Strategy/Guardrails and user-scope fields to the Settings tree", () => {
    for (const field of SETTINGS_FIELDS) {
      if (field.scope === "account") {
        expect(["strategy", "guardrails"]).toContain(field.destination);
      } else {
        expect(field.destination.startsWith("settings/")).toBe(true);
      }
    }
  });

  it("gives every field a stable id, a backing field, and a disclosure level", () => {
    const ids = new Set<string>();
    for (const field of SETTINGS_FIELDS) {
      expect(field.id).toBeTruthy();
      expect(field.backingField).toBeTruthy();
      expect(["essential", "advanced", "search-only"]).toContain(field.disclosure);
      expect(ids.has(field.id)).toBe(false); // ids are unique
      ids.add(field.id);
    }
  });
});

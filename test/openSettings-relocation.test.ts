import { describe, expect, it } from "vitest";
import {
  LEGACY_SECTION_RELOCATION,
  SETTINGS_GLOSSARY,
  relocationForSection
} from "../app/settings-search";
import { settingsTierForSection, type SettingsSection } from "../app/settings-scope";

// Compile-time-exhaustive list of legacy sections (a new SettingsSection member
// without a relocation entry is a tsc error, not silent coverage loss).
const ALL_SECTIONS = Object.keys({
  strategy: 0,
  operate: 0,
  risk: 0,
  connections: 0,
  display: 0,
  tax: 0,
  tuning: 0,
  notifications: 0,
  data: 0
} satisfies Record<SettingsSection, number>) as SettingsSection[];

describe("openSettings relocation map (PR #4)", () => {
  it("relocates every legacy section to a non-empty new home", () => {
    for (const section of ALL_SECTIONS) {
      const home = relocationForSection(section);
      expect(home).toBe(LEGACY_SECTION_RELOCATION[section]);
      expect(home.length).toBeGreaterThan(0);
    }
  });

  it("routes account-scope sections into Strategy/Guardrails/Results, user-scope into Settings", () => {
    for (const section of ALL_SECTIONS) {
      const home = relocationForSection(section);
      if (settingsTierForSection(section) === "account") {
        expect(/Strategy|Guardrails|Results/.test(home)).toBe(true);
      } else {
        expect(home.includes("Settings")).toBe(true);
      }
    }
  });
});

describe("Settings glossary old→new table (PR #4, copy deck §11)", () => {
  it("covers the load-bearing renames", () => {
    const oldNames = SETTINGS_GLOSSARY.map((e) => e.oldName);
    for (const needle of ["Strategy Profile", "Halt & Flatten", "Display", "Data", "/admin/* (four pages)"]) {
      expect(oldNames.some((n) => n.includes(needle) || n === needle)).toBe(true);
    }
  });

  it("maps the retired 'Notifications' noun to its three distinct new homes", () => {
    const notifRows = SETTINGS_GLOSSARY.filter((e) => e.oldName.startsWith("Notifications"));
    const newHomes = notifRows.map((e) => e.newHome);
    expect(newHomes).toContain("Results → Alert history");
    expect(newHomes).toContain("Settings → Alert delivery");
    expect(newHomes.some((h) => h.includes("Alerts"))).toBe(true);
  });

  it("every entry has an old name, a new home, and a what-changed note", () => {
    for (const entry of SETTINGS_GLOSSARY) {
      expect(entry.oldName).toBeTruthy();
      expect(entry.newHome).toBeTruthy();
      expect(entry.whatChanged.length).toBeGreaterThan(10);
    }
  });
});

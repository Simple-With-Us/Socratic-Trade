import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SETTINGS_SECTIONS,
  SCOPE_TAG_LABEL,
  scopeTagForSection,
  settingsTierForSection,
  type SettingsSection
} from "../app/settings-scope";

// Every settings section, derived from a compile-time-exhaustive source: the
// `satisfies Record<SettingsSection, ...>` forces every union member to be a key,
// so adding a section to `SettingsSection` without listing it here is a tsc error
// (not silent coverage loss). That is the actual drift guard that keeps the scope
// tag honest — the assertions below are then provably exhaustive.
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

describe("settings scope tags (PR #1)", () => {
  it("tags every account-scoped section THIS ACCOUNT", () => {
    for (const section of ALL_SECTIONS) {
      if (settingsTierForSection(section) === "account") {
        expect(scopeTagForSection(section)).toBe("THIS ACCOUNT");
      }
    }
    // The account-scoped set must be exactly the five account sections.
    expect([...ACCOUNT_SETTINGS_SECTIONS].sort()).toEqual(
      ["operate", "risk", "strategy", "tax", "tuning"]
    );
  });

  it("tags every user-scoped section ALL ACCOUNTS", () => {
    const userSections = ALL_SECTIONS.filter(
      (s) => settingsTierForSection(s) === "user"
    );
    expect(userSections.sort()).toEqual(
      ["connections", "data", "display", "notifications"]
    );
    for (const section of userSections) {
      expect(scopeTagForSection(section)).toBe("ALL ACCOUNTS");
    }
  });

  it("derives the tag from settingsTierForSection so copy can never drift", () => {
    for (const section of ALL_SECTIONS) {
      expect(scopeTagForSection(section)).toBe(
        SCOPE_TAG_LABEL[settingsTierForSection(section)]
      );
    }
  });

  it("only ever renders one of the two scope-tag strings", () => {
    const seen = new Set(ALL_SECTIONS.map(scopeTagForSection));
    expect([...seen].sort()).toEqual(["ALL ACCOUNTS", "THIS ACCOUNT"]);
  });
});

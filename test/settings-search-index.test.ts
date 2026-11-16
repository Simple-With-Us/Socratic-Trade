import { describe, expect, it } from "vitest";
import {
  SETTINGS_FIELDS,
  SETTINGS_GLOSSARY,
  hrefForSettingsField,
  searchSettings,
  settingsPaletteHits
} from "../app/settings-search";

describe("settings search index (PR #3)", () => {
  // The index is DERIVED from SETTINGS_FIELDS: searchSettings iterates the same
  // catalog the UI renders from. This is the "add-a-field-and-it's-searchable"
  // guarantee — every field in the catalog is findable by its own label with no
  // second list to maintain. Add a field to SETTINGS_FIELDS and this passes for
  // it automatically; a parallel search list would make this fail.
  it("makes every catalog field findable by its own label (no parallel list)", () => {
    for (const field of SETTINGS_FIELDS) {
      const results = searchSettings(field.label);
      expect(results.map((f) => f.id)).toContain(field.id);
    }
  });

  it("finds a field by an old-name synonym (redirect for returning users)", () => {
    // "max position size" is the OLD phrasing; it must resolve to the order-cap field.
    const byOldName = searchSettings("max position size");
    expect(byOldName.map((f) => f.id)).toContain("guardrails.maxOrderSize");
    // "notifications" (retired noun) still finds the alert-delivery field.
    expect(searchSettings("notifications").map((f) => f.id)).toContain("settings.alertWebhook");
  });

  it("matches by label, section/destination, scope word, and backing field", () => {
    expect(searchSettings("guardrails").length).toBeGreaterThan(0);
    expect(searchSettings("account").length).toBeGreaterThan(0);
    expect(searchSettings("maxOrderNotional").map((f) => f.id)).toContain("guardrails.maxOrderSize");
  });

  it("routes Roth IRA wash-sale ignore wording to the IRA-specific control", () => {
    expect(searchSettings("roth wash sale ignore").map((f) => f.id)).toContain("guardrails.iraWashSaleHandling");
  });

  it("ranks label-prefix hits ahead of synonym-only hits", () => {
    const results = searchSettings("stop-loss");
    expect(results[0]?.id).toBe("guardrails.stopLoss");
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("does not catalog the phantom defaultLandingAccount field", () => {
    expect(SETTINGS_FIELDS.some((f) => f.id === "settings.defaultLandingAccount")).toBe(false);
    expect(SETTINGS_FIELDS.some((f) => f.backingField === "defaultLandingAccount")).toBe(false);
    expect(searchSettings("default landing account").map((f) => f.id)).not.toContain(
      "settings.defaultLandingAccount"
    );
    expect(SETTINGS_GLOSSARY.some((e) => /default landing|auto-selected, for safety/i.test(e.whatChanged))).toBe(
      false
    );
  });

  it("deep-links every catalog field to a live console path (and known hash when set)", () => {
    const knownHashes = new Set([
      "autonomy",
      "tax",
      "scoring",
      "models",
      "danger",
      "brokers",
      "api-keys",
      "delivery",
      "scan-shape",
      "appearance",
      "data-sources",
      "confirmation",
      "notifications",
      "sharing",
      "legal",
      "learning-review",
      "llm-budget",
      "boot",
      "you",
      "glossary",
      "presets",
      "overlays",
      "instructions"
    ]);
    for (const field of SETTINGS_FIELDS) {
      const href = hrefForSettingsField(field);
      expect(href.startsWith("/console/")).toBe(true);
      const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
      if (field.anchor) {
        expect(hash).toBe(field.anchor);
        expect(knownHashes.has(hash)).toBe(true);
      } else {
        expect(hash).toBe("");
      }
    }
    expect(hrefForSettingsField(SETTINGS_FIELDS.find((f) => f.id === "settings.theme")!)).toBe(
      "/console/settings#appearance"
    );
    expect(hrefForSettingsField(SETTINGS_FIELDS.find((f) => f.id === "settings.llmDailyTokenBudget")!)).toBe(
      "/console/settings#llm-budget"
    );
    expect(hrefForSettingsField(SETTINGS_FIELDS.find((f) => f.id === "settings.apiKeys")!)).toBe(
      "/console/connections#api-keys"
    );
    expect(hrefForSettingsField(SETTINGS_FIELDS.find((f) => f.id === "guardrails.autonomy")!)).toBe(
      "/console/guardrails#autonomy"
    );
  });

  it("exposes palette hits with the same ranking and a live href", () => {
    expect(settingsPaletteHits("")).toEqual([]);
    const hits = settingsPaletteHits("theme");
    expect(hits.map((h) => h.id)).toContain("settings.theme");
    const theme = hits.find((h) => h.id === "settings.theme");
    expect(theme?.href).toBe("/console/settings#appearance");
    expect(theme?.hint).toBe("Settings · Appearance");
  });
});

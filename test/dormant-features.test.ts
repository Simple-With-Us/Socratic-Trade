import { describe, expect, it } from "vitest";
import { landingPageEnabled } from "../src/lib/landing-page";
import { listDormantFeatureStatus } from "../src/lib/dormant-features";

describe("landingPageEnabled", () => {
  it("defaults ON when unset (matches 2026-07-03 public marketing pages)", () => {
    expect(landingPageEnabled({})).toBe(true);
    expect(landingPageEnabled({ LANDING_PAGE_ENABLED: "" })).toBe(true);
  });

  it("honors explicit on/off", () => {
    expect(landingPageEnabled({ LANDING_PAGE_ENABLED: "true" })).toBe(true);
    expect(landingPageEnabled({ LANDING_PAGE_ENABLED: "on" })).toBe(true);
    expect(landingPageEnabled({ LANDING_PAGE_ENABLED: "off" })).toBe(false);
    expect(landingPageEnabled({ LANDING_PAGE_ENABLED: "0" })).toBe(false);
  });
});

describe("listDormantFeatureStatus", () => {
  it("marks ready-to-enable items without inventing rights/cost clearances", () => {
    const items = listDormantFeatureStatus({
      LANDING_PAGE_ENABLED: "on",
      CSP_ENABLED: "off",
      USAGE_BUDGET_ENFORCE: "off",
      VECTOR_EMBED_CLEAN_TEXT: "off",
      VECTOR_ASOF_STRICT: "off",
      RAG_MULTIQUERY: "off",
      RAG_HYDE: "off"
    });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["landing-page"]?.enabled).toBe(true);
    expect(byId["landing-page"]?.readyToEnable).toBe(true);
    expect(byId["csp-report-only"]?.readyToEnable).toBe(true);
    expect(byId["usage-budget-enforce"]?.readyToEnable).toBe(true);
    expect(byId["vector-embed-clean-text"]?.readyToEnable).toBe(true);
    expect(byId["vector-asof-strict"]?.readyToEnable).toBe(true);
    expect(byId["vector-asof-strict"]?.enabled).toBe(false);
    expect(byId["rag-multiquery"]?.readyToEnable).toBe(true);
    expect(byId["rag-hyde"]?.readyToEnable).toBe(true);
    expect(byId["sec8k-full-body"]?.readyToEnable).toBe(true);
    expect(byId["congress-share-outbound"]?.readyToEnable).toBe(true);
    expect(byId["apple-web-signin"]?.readyToEnable).toBe(false);
    expect(byId["fmp-transcripts"]?.readyToEnable).toBe(false);
  });

  it("marks web Apple ready only when AUTH_APPLE_* can arm the provider", () => {
    const off = listDormantFeatureStatus({});
    expect(off.find((i) => i.id === "apple-web-signin")?.enabled).toBe(false);
    const on = listDormantFeatureStatus({
      AUTH_APPLE_ID: "com.example.web",
      AUTH_APPLE_SECRET: "jwt"
    });
    expect(on.find((i) => i.id === "apple-web-signin")?.enabled).toBe(true);
    expect(on.find((i) => i.id === "apple-web-signin")?.readyToEnable).toBe(true);
  });
});

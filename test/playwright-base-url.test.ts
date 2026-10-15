import { describe, expect, it } from "vitest";
import { playwrightBaseURL } from "./e2e/playwright-base-url";

describe("playwrightBaseURL", () => {
  it("follows PLAYWRIGHT_PORT the same way playwright.config.ts does", () => {
    expect(playwrightBaseURL(undefined, "4217")).toBe("http://127.0.0.1:4217");
    expect(playwrightBaseURL(undefined, undefined)).toBe("http://127.0.0.1:4201");
    expect(playwrightBaseURL("http://127.0.0.1:4301", "4217")).toBe("http://127.0.0.1:4301");
  });
});

import { describe, expect, it } from "vitest";
import {
  PLAYWRIGHT_AUTH_SECRET_FIXTURE,
  resolvePlaywrightAuthSecret
} from "./e2e/playwright-auth-secret";

describe("resolvePlaywrightAuthSecret", () => {
  it("uses the env value when set", () => {
    expect(resolvePlaywrightAuthSecret({ PLAYWRIGHT_AUTH_SECRET: "from-ci" })).toBe("from-ci");
  });

  it("uses the local fixture outside CI", () => {
    expect(resolvePlaywrightAuthSecret({})).toBe(PLAYWRIGHT_AUTH_SECRET_FIXTURE);
  });

  it("fails closed in CI without an env secret", () => {
    expect(() => resolvePlaywrightAuthSecret({ CI: "true" })).toThrow(/PLAYWRIGHT_AUTH_SECRET is required in CI/);
  });
});

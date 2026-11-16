import { describe, expect, it } from "vitest";
import {
  SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER,
  remoteLogoSources,
  sourceOrderFor
} from "../src/lib/ticker-logo-policy";

describe("shared ticker logo policy (ST fallback)", () => {
  it("keeps GitHub first for ungraded names", () => {
    expect(sourceOrderFor("ZZZZ", "dark", undefined, SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER)[0]).toBe("github");
  });

  it("pins AAPL light to logo.dev and strips local for fetch", () => {
    const order = remoteLogoSources(sourceOrderFor("AAPL", "light"));
    expect(order[0]).toBe("logodev");
    expect(order).not.toContain("local");
  });
});

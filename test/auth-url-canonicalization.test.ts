import { describe, expect, it } from "vitest";
import { canonicalizeLegacyAuthEnv } from "../src/lib/public-origin";

describe("Auth.js public URL canonicalization", () => {
  it("rewrites legacy trading.jays.services auth env values to socratictrade.com", async () => {
    const env = {
      NEXT_PUBLIC_SITE_URL: "https://socratictrade.com",
      AUTH_URL: "https://trading.jays.services",
      NEXTAUTH_URL: "https://trading.jays.services"
    };

    canonicalizeLegacyAuthEnv(env);

    expect(env.AUTH_URL).toBe("https://socratictrade.com");
    expect(env.NEXTAUTH_URL).toBe("https://socratictrade.com");
  });

  it("preserves non-legacy preview auth hosts", async () => {
    const env = {
      NEXT_PUBLIC_SITE_URL: "https://codex.jays.services",
      AUTH_URL: "https://codex.jays.services",
      NEXTAUTH_URL: "https://codex.jays.services"
    };

    canonicalizeLegacyAuthEnv(env);

    expect(env.AUTH_URL).toBe("https://codex.jays.services");
    expect(env.NEXTAUTH_URL).toBe("https://codex.jays.services");
  });
});

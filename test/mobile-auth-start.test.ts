import { afterEach, describe, expect, it } from "vitest";
import { sameOriginCallback } from "../src/lib/mobile-auth-start";
import { resolvePublicAppOrigin } from "../src/lib/public-origin";

// The initiator resolves its origin via resolvePublicAppOrigin, which deliberately
// ignores forwarded headers in production because they are client-influenceable at a
// directly reachable origin.  Deriving the origin from X-Forwarded-Host would let an
// attacker aim this PUBLIC route's fallback redirect at their own host.
describe("auth-start origin resolution", () => {
  const env = process.env.NODE_ENV;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  const authUrl = process.env.AUTH_URL;
  const nextAuthUrl = process.env.NEXTAUTH_URL;

  const setNodeEnv = (value: string) =>
    Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true, writable: true, enumerable: true });

  // Assigning a captured `undefined` back onto process.env coerces it to the STRING
  // "undefined", which is truthy — with vitest on a single worker that leaks a fake
  // site URL into later files (app/layout.tsx feeds it to new URL()).  Delete instead.
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    setNodeEnv(env as string);
    restore("NEXT_PUBLIC_SITE_URL", site);
    restore("AUTH_URL", authUrl);
    restore("NEXTAUTH_URL", nextAuthUrl);
  });

  it("ignores a spoofed X-Forwarded-Host in production and stays on the canonical origin", () => {
    setNodeEnv("production");
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    const request = new Request("http://localhost:3000/api/mobile/auth-start?provider=google", {
      headers: { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https", host: "evil.example.com" }
    });
    expect(resolvePublicAppOrigin(request)).toBe("https://socratictrade.com");
  });

  it("resolves the public origin rather than the internal container origin (the owner-reported regression)", () => {
    setNodeEnv("production");
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    const request = new Request("http://localhost:3000/api/mobile/auth-start?provider=google");
    expect(resolvePublicAppOrigin(request)).toBe("https://socratictrade.com");
  });
});

describe("sameOriginCallback", () => {
  const PUBLIC = "https://socratictrade.com";

  it("keeps the absolute mobile handoff URL when the public origin matches (the owner-reported regression)", () => {
    expect(
      sameOriginCallback("https://socratictrade.com/api/mobile/auth-redirect?code_challenge=abc", PUBLIC)
    ).toBe("/api/mobile/auth-redirect?code_challenge=abc");
  });

  it("keeps the canonical-origin callback even when the resolved origin differs (internal request URL)", () => {
    expect(
      sameOriginCallback("https://socratictrade.com/api/mobile/auth-redirect?code_challenge=abc", "http://localhost:3000")
    ).toBe("/api/mobile/auth-redirect?code_challenge=abc");
  });

  it("keeps relative paths", () => {
    expect(sameOriginCallback("/console", PUBLIC)).toBe("/console");
  });

  it("clamps cross-origin callbacks to /", () => {
    expect(sameOriginCallback("https://evil.example.com/steal", PUBLIC)).toBe("/");
  });

  it("clamps garbage and empty input to /", () => {
    expect(sameOriginCallback("http://[malformed", PUBLIC)).toBe("/");
    expect(sameOriginCallback(null, PUBLIC)).toBe("/");
  });
});

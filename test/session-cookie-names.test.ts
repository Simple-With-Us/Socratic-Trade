import { describe, expect, it, vi } from "vitest";
import {
  pickSessionCookie,
  sessionTokenForCurrentCookie,
} from "../src/lib/auth/session-cookie-names";
import { decodeSessionToken, encodeSessionToken } from "../src/lib/auth/session-token";

describe("pickSessionCookie", () => {
  it("prefers Auth.js names over NextAuth v4 names", () => {
    const picked = pickSessionCookie([
      { name: "next-auth.session-token", value: "legacy" },
      { name: "authjs.session-token", value: "current" },
    ]);
    expect(picked).toEqual({ name: "authjs.session-token", value: "current" });
  });

  it("accepts a legacy NextAuth cookie when no Auth.js cookie is present", () => {
    const picked = pickSessionCookie([
      { name: "next-auth.session-token", value: "legacy" },
      { name: "other.session-token-backup", value: "not-a-session" },
    ]);
    expect(picked).toEqual({ name: "next-auth.session-token", value: "legacy" });
  });

  it("ignores unrelated cookies whose names merely contain session-token", () => {
    expect(
      pickSessionCookie([{ name: "csrf.session-token-hint", value: "nope" }]),
    ).toBeUndefined();
  });
});

describe("sessionTokenForCurrentCookie", () => {
  it("passes through a current-salt token without AUTH_SECRET", async () => {
    const result = await sessionTokenForCurrentCookie({
      sessionToken: "session-secret",
      cookieName: "authjs.session-token",
      secret: undefined,
    });
    expect(result).toEqual({
      cookieName: "authjs.session-token",
      token: "session-secret",
    });
  });

  it("reissues a next-auth salted JWT under the current Auth.js salt", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    const legacy = await encodeSessionToken({
      token: { email: "owner@example.com" },
      secret,
      salt: "next-auth.session-token",
    });
    const result = await sessionTokenForCurrentCookie({
      sessionToken: legacy,
      cookieName: "next-auth.session-token",
      secret,
    });
    expect(result?.cookieName).toBe("authjs.session-token");
    expect(result?.token).toBeTruthy();
    expect(result?.token).not.toBe(legacy);
    const payload = await decodeSessionToken({
      token: result!.token,
      secret,
      salt: "authjs.session-token",
    });
    expect(payload?.email).toBe("owner@example.com");
  });

  it("preserves the remaining lifetime when reissuing a legacy token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    const secret = "test-secret-at-least-32-bytes-long!!";
    const legacy = await encodeSessionToken({
      token: { email: "owner@example.com" },
      secret,
      salt: "next-auth.session-token",
      maxAge: 120,
    });
    vi.setSystemTime(new Date("2026-08-30T12:00:30.000Z"));

    const result = await sessionTokenForCurrentCookie({
      sessionToken: legacy,
      cookieName: "next-auth.session-token",
      secret,
    });

    expect(result?.maxAge).toBe(90);
    const payload = await decodeSessionToken({
      token: result?.token,
      secret,
      salt: "authjs.session-token",
    });
    expect(payload?.exp).toBe(Math.floor(Date.parse("2026-08-30T12:02:00.000Z") / 1000));
    vi.useRealTimers();
  });

  it("returns undefined when a legacy token cannot be verified", async () => {
    const result = await sessionTokenForCurrentCookie({
      sessionToken: "not-a-jwt",
      cookieName: "next-auth.session-token",
      secret: "test-secret-at-least-32-bytes-long!!",
    });
    expect(result).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { POST } from "../app/api/mobile/auth/exchange/route";
import { decodeSessionToken, encodeSessionToken } from "../src/lib/auth/session-token";
import { createMobileAuthHandoff } from "../src/lib/mobile-auth-handoff";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

describe("mobile OAuth exchange route", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns no session credential in its JSON response and sets an HTTP-only cookie", async () => {
    const verifier = "v".repeat(43);
    const code = createMobileAuthHandoff({
      sessionToken: "session-secret",
      codeChallenge: challenge(verifier)
    });
    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("authjs.session-token=session-secret");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
  });

  it("reissues a legacy next-auth session JWT under the current Auth.js cookie salt", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("AUTH_SECRET", secret);
    const verifier = "v".repeat(43);
    const legacyToken = await encodeSessionToken({
      token: { email: "owner@example.com", sub: "user-1" },
      secret,
      salt: "next-auth.session-token",
    });
    const code = createMobileAuthHandoff({
      sessionToken: legacyToken,
      cookieName: "next-auth.session-token",
      codeChallenge: challenge(verifier),
    });
    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier }),
    }));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("authjs.session-token=");
    expect(setCookie).not.toContain("next-auth.session-token=");
    const cookieValue = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    const payload = await decodeSessionToken({
      token: cookieValue,
      secret,
      salt: "authjs.session-token",
    });
    expect(payload?.email).toBe("owner@example.com");
    expect(
      await decodeSessionToken({ token: cookieValue, secret, salt: "next-auth.session-token" }),
    ).toBeNull();
  });

  it("sets the reissued cookie to the legacy session's remaining lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("AUTH_SECRET", secret);
    const verifier = "v".repeat(43);
    const legacyToken = await encodeSessionToken({
      token: { sub: "user-1" },
      secret,
      salt: "next-auth.session-token",
      maxAge: 120,
    });
    vi.setSystemTime(new Date("2026-08-30T12:00:30.000Z"));
    const code = createMobileAuthHandoff({
      sessionToken: legacyToken,
      cookieName: "next-auth.session-token",
      codeChallenge: challenge(verifier),
    });

    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier }),
    }));

    expect(response.headers.get("set-cookie")).toContain("Max-Age=90");
    vi.useRealTimers();
  });

  it("rejects a legacy session whose JWT cannot be verified under the source salt", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const verifier = "v".repeat(43);
    const code = createMobileAuthHandoff({
      sessionToken: "not-a-jwt",
      cookieName: "next-auth.session-token",
      codeChallenge: challenge(verifier),
    });
    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier }),
    }));
    expect(response.status).toBe(401);
  });
});

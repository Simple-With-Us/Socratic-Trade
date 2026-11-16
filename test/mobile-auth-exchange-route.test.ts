import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { POST } from "../app/api/mobile/auth/exchange/route";
import { decodeSessionToken, encodeSessionToken } from "../src/lib/auth/session-token";
import { createMobileAuthHandoff } from "../src/lib/mobile-auth-handoff";
import {
  LEGACY_MOBILE_HANDOFF_NONCE,
  LEGACY_MOBILE_SESSION_ID,
} from "../src/lib/auth/mobile-session-hardening";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-exchange-${randomUUID()}.db`)}`;
});

describe("mobile OAuth exchange route", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns no session credential in its JSON response and sets an HTTP-only cookie", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("AUTH_SECRET", secret);
    const sessionToken = await encodeSessionToken({
      token: { email: "handoff@example.com" },
      secret,
      salt: "authjs.session-token",
    });
    const verifier = "v".repeat(43);
    const code = createMobileAuthHandoff({
      sessionToken,
      codeChallenge: challenge(verifier),
      handoffNonce: LEGACY_MOBILE_HANDOFF_NONCE,
      sessionId: LEGACY_MOBILE_SESSION_ID,
    });
    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("authjs.session-token=");
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
      handoffNonce: LEGACY_MOBILE_HANDOFF_NONCE,
      sessionId: LEGACY_MOBILE_SESSION_ID,
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
    try {
      vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
      const secret = "test-secret-at-least-32-bytes-long!!";
      vi.stubEnv("AUTH_SECRET", secret);
      const verifier = "v".repeat(43);
      const legacyToken = await encodeSessionToken({
        token: { sub: "user-1", email: "max-age@example.com" },
        secret,
        salt: "next-auth.session-token",
        maxAge: 120,
      });
      vi.setSystemTime(new Date("2026-08-30T12:00:30.000Z"));
      const code = createMobileAuthHandoff({
        sessionToken: legacyToken,
        cookieName: "next-auth.session-token",
        codeChallenge: challenge(verifier),
        handoffNonce: LEGACY_MOBILE_HANDOFF_NONCE,
        sessionId: LEGACY_MOBILE_SESSION_ID,
      });

      const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
        method: "POST",
        body: JSON.stringify({ code, codeVerifier: verifier }),
      }));

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=90");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 500 without burning the handoff code when AUTH_SECRET is unset", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    const verifier = "v".repeat(43);
    const sessionToken = await encodeSessionToken({
      token: { email: "handoff@example.com" },
      secret,
      salt: "authjs.session-token",
    });
    const code = createMobileAuthHandoff({
      sessionToken,
      codeChallenge: challenge(verifier),
      handoffNonce: LEGACY_MOBILE_HANDOFF_NONCE,
      sessionId: LEGACY_MOBILE_SESSION_ID,
    });
    vi.stubEnv("AUTH_SECRET", "");
    const misconfig = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier }),
    }));
    expect(misconfig.status).toBe(500);

    vi.stubEnv("AUTH_SECRET", secret);
    const retry = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier }),
    }));
    expect(retry.status).toBe(200);
  });

  it("rejects a legacy session whose JWT cannot be verified under the source salt", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const verifier = "v".repeat(43);
    const code = createMobileAuthHandoff({
      sessionToken: "not-a-jwt",
      cookieName: "next-auth.session-token",
      codeChallenge: challenge(verifier),
      handoffNonce: LEGACY_MOBILE_HANDOFF_NONCE,
      sessionId: LEGACY_MOBILE_SESSION_ID,
    });
    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier }),
    }));
    expect(response.status).toBe(401);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  signIn: vi.fn()
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mocks.cookieGet }))
}));

vi.mock("@/lib/auth/auth", () => ({
  signIn: mocks.signIn
}));

function verifier(seed: string): string {
  return createHash("sha256").update(seed).digest("base64url");
}

function challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("DATABASE_URL", `file:${join(tmpdir(), `agentic-mobile-auth-${randomUUID()}.db`)}`);
  vi.stubEnv("ENCRYPTION_KEY", "11".repeat(32));
  mocks.cookieGet.mockReset();
  mocks.signIn.mockReset();
});

describe("mobile OAuth one-time exchange", () => {
  it("binds a short-lived code to state + PKCE and consumes it exactly once", async () => {
    const codeVerifier = verifier("mobile-verifier");
    const state = verifier("mobile-state");
    const { consumeMobileAuthExchange, issueMobileAuthExchange } = await import("../src/lib/mobile-auth-exchange");
    const { getDb } = await import("../src/lib/db");

    const issued = issueMobileAuthExchange({
      sessionToken: "signed-session-token",
      state,
      codeChallenge: challenge(codeVerifier),
      now: 1_000
    });
    expect(issued.code).toHaveLength(43);
    const stored = getDb()
      .prepare("SELECT value FROM settings WHERE key LIKE 'mobile_auth_exchange:%'")
      .get() as { value: string };
    expect(stored.value).not.toContain("signed-session-token");

    expect(consumeMobileAuthExchange({ code: issued.code, state, codeVerifier, now: 1_001 })).toBe("signed-session-token");
    expect(consumeMobileAuthExchange({ code: issued.code, state, codeVerifier, now: 1_002 })).toBeUndefined();
  });

  it("rejects wrong state/verifier without exposing or consuming the valid exchange", async () => {
    const codeVerifier = verifier("valid-verifier");
    const state = verifier("valid-state");
    const { consumeMobileAuthExchange, issueMobileAuthExchange } = await import("../src/lib/mobile-auth-exchange");
    const issued = issueMobileAuthExchange({
      sessionToken: "signed-session-token",
      state,
      codeChallenge: challenge(codeVerifier)
    });

    expect(consumeMobileAuthExchange({ code: issued.code, state: verifier("wrong-state"), codeVerifier })).toBeUndefined();
    expect(consumeMobileAuthExchange({ code: issued.code, state, codeVerifier: verifier("wrong-verifier") })).toBeUndefined();
    expect(consumeMobileAuthExchange({ code: issued.code, state, codeVerifier })).toBe("signed-session-token");
  });

  it("rejects and removes an expired exchange", async () => {
    const codeVerifier = verifier("expiry-verifier");
    const state = verifier("expiry-state");
    const { consumeMobileAuthExchange, issueMobileAuthExchange } = await import("../src/lib/mobile-auth-exchange");
    const issued = issueMobileAuthExchange({
      sessionToken: "signed-session-token",
      state,
      codeChallenge: challenge(codeVerifier),
      now: 1_000,
      ttlMs: 100
    });

    expect(consumeMobileAuthExchange({ code: issued.code, state, codeVerifier, now: 1_101 })).toBeUndefined();
  });

  it("redirects through the custom scheme with code + state but never a JWT", async () => {
    const codeVerifier = verifier("redirect-verifier");
    const state = verifier("redirect-state");
    mocks.cookieGet.mockImplementation((name: string) =>
      name === "__Secure-authjs.session-token" ? { value: "signed-session-token" } : undefined
    );
    const { GET } = await import("../app/api/mobile/auth-redirect/route");
    const { consumeMobileAuthExchange } = await import("../src/lib/mobile-auth-exchange");

    const response = await GET(
      new Request(
        `https://socratictrade.com/api/mobile/auth-redirect?state=${state}&code_challenge=${challenge(codeVerifier)}`
      )
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.protocol).toBe("socratictrade:");
    expect(location.searchParams.get("token")).toBeNull();
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code")!;
    expect(consumeMobileAuthExchange({ code, state, codeVerifier })).toBe("signed-session-token");
  });

  it("sets the session only on the HTTPS code exchange response", async () => {
    const codeVerifier = verifier("cookie-verifier");
    const state = verifier("cookie-state");
    const { issueMobileAuthExchange } = await import("../src/lib/mobile-auth-exchange");
    const { POST } = await import("../app/api/mobile/auth/exchange/route");
    const issued = issueMobileAuthExchange({
      sessionToken: "signed-session-token",
      state,
      codeChallenge: challenge(codeVerifier)
    });

    const response = await POST(
      new Request("https://socratictrade.com/api/mobile/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: issued.code, state, codeVerifier })
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toContain("authjs.session-token=signed-session-token");
  });

  it("starts Google OAuth through the Auth.js server signIn action", async () => {
    vi.stubEnv("AUTH_GOOGLE_ID", "google-id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret");
    mocks.signIn.mockResolvedValue(undefined);
    const codeVerifier = verifier("start-verifier");
    const state = verifier("start-state");
    const { GET } = await import("../app/api/mobile/auth/start/route");

    const response = await GET(
      new Request(
        `https://socratictrade.com/api/mobile/auth/start?provider=google&state=${state}&code_challenge=${challenge(codeVerifier)}`
      )
    );

    expect(mocks.signIn).toHaveBeenCalledWith("google", {
      redirectTo: `https://socratictrade.com/api/mobile/auth-redirect?state=${state}&code_challenge=${challenge(codeVerifier)}`
    });
    // Real Auth.js throws/returns the framework redirect; this fallback only protects an impossible return.
    expect(response.status).toBe(500);
  });
});

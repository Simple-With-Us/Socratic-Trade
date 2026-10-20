/**
 * The middleware never hands the session verifier a placeholder credential.
 *
 * The alt-domain canonicalization hop has to decide whether the request belongs
 * to a signed-in operator, and it decides it by verifying the Auth.js session
 * cookie.  That verification needs the Auth.js secret.  When the secret is not
 * configured there is no Auth.js session to verify, and the honest answer is
 * "no session" — not "a session that failed to verify", and certainly not an
 * empty string handed to the verifier as though it were a secret.
 *
 * The distinction matters because the two are the same answer to a caller that
 * only sees a null identity, so a missing secret would silently look like a
 * cookie problem.  A live boot surfaces a missing secret where it belongs, at
 * startup, through assertAuthSecretConfiguredInLiveBootstrap(); a
 * Cloudflare-Access-only deployment has no AUTH_SECRET by design and is not an
 * error at all.
 *
 * This file mocks the verifier so the secret it actually receives can be
 * inspected.  The behavioural coverage — a signed-in operator stays on the alt
 * domain, anonymous traffic is forwarded — lives in public-site-routing.test.ts
 * against the real verifier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifierCalls: string[] = [];

vi.mock("../src/lib/auth/session-edge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth/session-edge")>();
  return {
    ...actual,
    getSessionIdentity: async (_cookieHeader: string | null, authSecret: string) => {
      verifierCalls.push(authSecret);
      return actual.getSessionIdentity(_cookieHeader, authSecret);
    }
  };
});

const { middleware } = await import("../middleware");

function createRequest(urlStr: string, hostHeader: string): NextRequest {
  return new NextRequest(urlStr, {
    headers: {
      host: hostHeader,
      "user-agent": "test-agent"
    }
  });
}

describe("middleware — the Auth.js secret is never a placeholder", () => {
  const previous = process.env.AUTH_SECRET;

  beforeEach(() => {
    verifierCalls.length = 0;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  });

  it("does not verify a session at all when AUTH_SECRET is not set", async () => {
    delete process.env.AUTH_SECRET;
    const res = await middleware(createRequest("https://socratic.trade/welcome", "socratic.trade"));
    expect(verifierCalls).toEqual([]);
    // No secret means no Auth.js session, so the request is anonymous and is
    // forwarded to the canonical host.
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://socratictrade.com/welcome");
  });

  it("does not verify a session with a blank AUTH_SECRET", async () => {
    // A blank secret is not a credential.  Passing one would make "no secret
    // configured" and "the cookie did not verify" the same answer.
    process.env.AUTH_SECRET = "";
    const res = await middleware(createRequest("https://socratic.trade/welcome", "socratic.trade"));
    expect(verifierCalls).toEqual([]);
    expect(res.status).toBe(308);
  });

  it("does not verify a session with a whitespace-only AUTH_SECRET", async () => {
    process.env.AUTH_SECRET = "   ";
    const res = await middleware(createRequest("https://socratic.trade/welcome", "socratic.trade"));
    expect(verifierCalls).toEqual([]);
    expect(res.status).toBe(308);
  });

  it("passes the configured secret through unchanged", async () => {
    const secret = "test-secret-for-the-auth-secret-guard";
    process.env.AUTH_SECRET = secret;
    const res = await middleware(createRequest("https://socratic.trade/welcome", "socratic.trade"));
    expect(verifierCalls).toContain(secret);
    for (const used of verifierCalls) {
      expect(used).not.toBe("");
      expect(used.trim()).not.toBe("");
    }
    // The secret was used, so the verifier ran, and with no valid cookie the request
    // is anonymous and is forwarded.
    expect(res.status).toBe(308);
  });
});

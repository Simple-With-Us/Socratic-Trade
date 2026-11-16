/**
 * Unit tests for app/api/mobile/auth/apple/route.ts POST handler.
 *
 * Covers two ITEM 13 fixes:
 *   1. createRemoteJWKSet is now created ONCE at module scope, not per request — jose's
 *      createRemoteJWKSet builds a caching key-fetcher, so re-creating it inside the handler
 *      threw that cache away every request (every sign-in re-fetched Apple's JWKS endpoint).
 *   2. The request body now has an explicit byte cap (readJsonWithLimit), independent of any
 *      content-length header.
 *
 * `jose` is mocked so no real network call ever reaches https://appleid.apple.com.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAppleSignInNonce } from "../src/lib/auth/apple-signin-nonce";

const mocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => "JWKS_SENTINEL" as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>),
  appleNonce: "",
  // Declared with explicit (token, jwks) params so mock.calls is typed as a 2-tuple — the
  // JWKS-reuse test below reads call[1] to assert reference equality across requests.
  jwtVerify: vi.fn(
    async (_token: unknown, _jwks: unknown) =>
      ({
        payload: { email: "owner@example.com", nonce: mocks.appleNonce },
      }) as unknown as Awaited<ReturnType<typeof import("jose").jwtVerify>>,
  ),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: mocks.createRemoteJWKSet,
  jwtVerify: mocks.jwtVerify
}));

vi.mock("../src/lib/auth/identity", () => ({
  isEmailAllowed: () => true,
  userIdForEmail: (email: string) => `uid-${email}`,
}));

const APPLE_AUTH_URL = "http://localhost/api/mobile/auth/apple";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-apple-auth-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jwtVerify.mockImplementation(
    async (_token: unknown, _jwks: unknown) =>
      ({
        payload: { email: "owner@example.com", nonce: mocks.appleNonce },
      }) as unknown as Awaited<ReturnType<typeof import("jose").jwtVerify>>,
  );
  process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars";
});

describe("POST /api/mobile/auth/apple", () => {
  it("creates the remote JWKS resolver ONCE at module scope, reused across every request (not per-request)", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    expect(mocks.createRemoteJWKSet).toHaveBeenCalledTimes(1); // module-load side effect, before any request

    for (let i = 0; i < 3; i++) {
      mocks.appleNonce = issueAppleSignInNonce();
      const res = await POST(
        new Request(APPLE_AUTH_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identityToken: "token", name: "Owner", nonce: mocks.appleNonce })
        })
      );
      expect(res.status).toBe(200);
    }

    // Still exactly one resolver instance after 3 requests — jose's own internal JWKS/HTTP cache
    // is only effective if the SAME resolver object is reused across calls.
    expect(mocks.createRemoteJWKSet).toHaveBeenCalledTimes(1);
    expect(mocks.jwtVerify).toHaveBeenCalledTimes(3);
    // Every call must have received the exact same resolver instance (reference equality).
    const resolverArgs = mocks.jwtVerify.mock.calls.map((call) => call[1]);
    expect(new Set(resolverArgs).size).toBe(1);
  });

  it("allows legacy iOS builds without a server nonce", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken: "token", name: "Owner" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.jwtVerify).toHaveBeenCalled();
  });

  it("rejects hardened clients that omit the server nonce (400)", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-socratic-mobile-session-hardening": "1",
        },
        body: JSON.stringify({ identityToken: "token" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.jwtVerify).not.toHaveBeenCalled();
  });

  it("accepts an identity token whose nonce is the SHA-256 hex of the issued nonce", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    const { appleSignInNonceDigest } = await import("../src/lib/auth/apple-signin-nonce");
    const issued = issueAppleSignInNonce();
    mocks.appleNonce = appleSignInNonceDigest(issued);
    expect(appleSignInNonceDigest("server-nonce")).toBe(
      "0891992dd7ec661dc2bf5be407acf21fd557daf14f762be012caaa04c9373eb1",
    );
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-socratic-mobile-session-hardening": "1",
          "cf-connecting-ip": "203.0.113.45",
        },
        body: JSON.stringify({ identityToken: "token", nonce: issued }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a token nonce that is neither the issued nonce nor its digest", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    const issued = issueAppleSignInNonce();
    mocks.appleNonce = "not-the-issued-nonce";
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-socratic-mobile-session-hardening": "1",
          "cf-connecting-ip": "203.0.113.46",
        },
        body: JSON.stringify({ identityToken: "token", nonce: issued }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing identityToken (400)", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON (400) without ever calling jwtVerify", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json"
      })
    );
    expect(res.status).toBe(400);
    expect(mocks.jwtVerify).not.toHaveBeenCalled();
  });

  it("rejects a request body over the byte cap (413) without ever calling jwtVerify", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    mocks.appleNonce = issueAppleSignInNonce();
    const oversized = JSON.stringify({
      identityToken: "x".repeat(64 * 1024),
      name: "Owner",
      nonce: mocks.appleNonce,
    });
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized
      })
    );
    expect(res.status).toBe(413);
    expect(mocks.jwtVerify).not.toHaveBeenCalled();
  });

  it("accepts a realistically-sized identityToken (a JWT is a few KB at most) under the cap", async () => {
    const { POST } = await import("../app/api/mobile/auth/apple/route");
    // A real Apple identityToken JWT is typically 1-2 KB; use a generously large but realistic 4 KB.
    const realisticToken = "x".repeat(4 * 1024);
    mocks.appleNonce = issueAppleSignInNonce();
    const res = await POST(
      new Request(APPLE_AUTH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken: realisticToken, name: "Owner", nonce: mocks.appleNonce })
      })
    );
    expect(res.status).toBe(200);
  });
});

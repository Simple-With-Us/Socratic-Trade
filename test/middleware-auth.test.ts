// Middleware auth unit tests (Phase-11 M6).
//
// Tests the four critical behaviors:
//   1. authConfigured=true + no identity → FAIL CLOSED (401 for /api/*)
//      (regression test for the NODE_ENV-edge-inlining IDOR bug)
//   2. Cloudflare Access headers are ignored as app identity
//   3. Auth.js session JWT → trusted and allowlisted
//   4. authConfigured=false → PRIMARY fallback (dev/test behavior preserved)
//   5. Forged x-user-id / x-authenticated-user-email are stripped
//
// We invoke `middleware()` directly with a mocked NextRequest — the middleware
// module re-exports `middleware` as a named export, which we import here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { encodeSessionToken } from "../src/lib/auth/session-token";

// Dynamic import lets us re-import with fresh module state after stubbing env.
// We use `vi.resetModules()` to flush the module cache between tests that need
// different env var states.
async function loadMiddleware() {
  const mod = await import("../middleware.js");
  return mod.middleware as (req: NextRequest) => Promise<import("next/server").NextResponse>;
}

function makeRequest(path: string, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://trading.example.com${path}`, {
    headers: extraHeaders
  });
}

/** Mint a valid Auth.js-style session JWT signed with the given secret. */
async function mintSessionJwt(email: string, secret: string, loginAt?: number): Promise<string> {
  return await encodeSessionToken({
    token: { email, ...(loginAt !== undefined ? { loginAt } : {}) },
    secret,
    salt: "authjs.session-token",
    maxAge: 60 * 60
  });
}

/**
 * Cloudflare Access JWT test harness (Item 12 fix): generates a real RSA keypair, serves it as the
 * mocked `/cdn-cgi/access/certs` JWKS endpoint (via a stubbed global `fetch`), and mints assertions
 * signed against it. This exercises the REAL verification path in middleware.ts (issuer, audience,
 * signature) — unlike the old unsigned `fakeCfAccessAssertion` fixture this replaces, which the
 * pre-fix code never actually verified.
 */
async function armCfAccessJwks(teamDomain: string): Promise<{
  mintAssertion: (
    email: string,
    opts?: { audience?: string; issuedAtMs?: number; expiresInSec?: number; badSignature?: boolean }
  ) => Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : (input as Request).url;
      if (url === certsUrl) {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    })
  );

  return {
    async mintAssertion(email, opts = {}) {
      const signingKey = opts.badSignature ? (await generateKeyPair("RS256")).privateKey : privateKey;
      let builder = new SignJWT({ email })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(`https://${teamDomain}`)
        .setAudience(opts.audience ?? "test-audience-tag")
        .setExpirationTime(Math.floor(Date.now() / 1_000) + (opts.expiresInSec ?? 3600));
      builder = opts.issuedAtMs !== undefined ? builder.setIssuedAt(Math.floor(opts.issuedAtMs / 1_000)) : builder.setIssuedAt();
      return builder.sign(signingKey);
    }
  };
}

describe("middleware — fail-closed arming (Phase-11 M6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // ── Test 1: regression — the IDOR that existed before this fix ──────────────
  it("FAIL CLOSED: authConfigured (AUTH_SECRET set) + no identity → 401 for /api/*", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("FAIL CLOSED: redirect to /login for non-api pages when armed with no identity", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  // ── Test 2: Cloudflare Access header trust requires team-domain + audience + a verified JWT ──
  it("trusts the CF header only when armed with team domain + audience + a verified JWT assertion", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const assertion = await mintAssertion("verified@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "verified@example.com",
      "cf-access-jwt-assertion": assertion
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBe("verified@example.com");
    expect(res.headers.get("x-middleware-request-x-authenticated-identity-source")).toBe("cloudflare-access");
  });

  it("does not treat a Cloudflare application-token issue time as a fresh provider login", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    const issuedAt = Date.parse("2026-07-14T20:00:00.000Z");
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const assertion = await mintAssertion("verified@example.com", { issuedAtMs: issuedAt });
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "verified@example.com",
      "cf-access-jwt-assertion": assertion
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-session-issued-at")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-authenticated-identity-source"))
      .toBe("cloudflare-access");
  });

  it("uses a matching signed Auth.js login proof alongside Cloudflare Access", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    const secret = "test-secret-at-least-32-bytes-long!!";
    const loginAt = Date.parse("2026-07-14T20:00:00.000Z");
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const assertion = await mintAssertion("verified@example.com");
    const jwt = await mintSessionJwt("verified@example.com", secret, loginAt);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "verified@example.com",
      "cf-access-jwt-assertion": assertion,
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-session-issued-at"))
      .toBe("2026-07-14T20:00:00.000Z");
    expect(res.headers.get("x-middleware-request-x-authenticated-identity-source"))
      .toBe("authjs-session");
  });

  it("ignores a signed Auth.js login proof for a different Cloudflare identity", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const assertion = await mintAssertion("verified@example.com");
    const jwt = await mintSessionJwt("other@example.com", secret, Date.parse("2026-07-14T20:00:00.000Z"));
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "verified@example.com",
      "cf-access-jwt-assertion": assertion,
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email"))
      .toBe("verified@example.com");
    expect(res.headers.get("x-middleware-request-x-authenticated-session-issued-at")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-authenticated-identity-source"))
      .toBe("cloudflare-access");
  });

  // ── Item 12 fix: the flag alone must never trust the header (fail-closed regression suite) ──
  it("FIXED: flag alone (no team-domain/aud/JWT) no longer trusts a spoofed header", async () => {
    // Regression test for the vulnerability this fix closes: previously CF_ACCESS_TRUST_EMAIL_HEADER=1
    // trusted `cf-access-authenticated-user-email` outright with no verification. Since the origin is
    // directly reachable, that header is a plain, attacker-settable HTTP header — a spoofed value was
    // a full auth bypass. Now the flag alone arms nothing: CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD must
    // also be set, and the header is only trusted alongside a verified Cf-Access-Jwt-Assertion.
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example"
    });
    const res = await middleware(req);
    // authConfigured is still true (flag on) so this fails closed (401) rather than trusting the
    // spoofed header OR falling open to the PRIMARY_EMAIL dev fallback.
    expect(res.status).toBe(401);
  });

  it("flag on + team-domain/aud configured but NO JWT assertion → header ignored, fails closed", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example"
      // deliberately no cf-access-jwt-assertion header
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("flag on + team-domain/aud configured but a garbage JWT assertion → header ignored, fails closed", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    await armCfAccessJwks(teamDomain);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example",
      "cf-access-jwt-assertion": "not.a.validjwt"
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("flag on + JWT signed by an untrusted key → header ignored, fails closed", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const forged = await mintAssertion("attacker@evil.example", { badSignature: true });
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example",
      "cf-access-jwt-assertion": forged
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("flag on + valid JWT but WRONG audience → header ignored, fails closed", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const wrongAud = await mintAssertion("verified@example.com", { audience: "some-other-app" });
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "verified@example.com",
      "cf-access-jwt-assertion": wrongAud
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("flag on + valid JWT but header/JWT email MISMATCH → header ignored, fails closed", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "test-audience-tag");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { mintAssertion } = await armCfAccessJwks(teamDomain);
    const assertion = await mintAssertion("verified@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      // header claims a DIFFERENT email than the one the verified JWT actually attests to
      "cf-access-authenticated-user-email": "attacker@evil.example",
      "cf-access-jwt-assertion": assertion
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("flag on + CF_ACCESS_TEAM_DOMAIN set but CF_ACCESS_AUD missing → not armed, header ignored", async () => {
    const teamDomain = "test-team.cloudflareaccess.com";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example"
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it.each(["0", "false", "no", "off"])("treats CF_ACCESS_TRUST_EMAIL_HEADER=%s as disabled", async (flag) => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", flag);
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example"
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBe("owner@example.com");
  });

  it("keeps Auth.js fail-closed when CF header trust is explicitly off", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "0");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "owner@example.com"
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  // ── Test 3: Auth.js session JWT → trusted ────────────────────────────────────
  it("valid Auth.js session JWT for primary user → trusted, forwarded", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const jwt = await mintSessionJwt("owner@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("owner@example.com");
  });

  it("forwards the explicit provider-login time used for account-generation binding", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    const loginAt = Date.parse("2026-07-14T20:00:00.123Z");
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const jwt = await mintSessionJwt("owner@example.com", secret, loginAt);
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-session-issued-at"))
      .toBe("2026-07-14T20:00:00.123Z");
  });

  it("valid Auth.js session JWT for allowlisted non-primary user → trusted, forwarded", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "user@example.com");
    const jwt = await mintSessionJwt("user@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("user@example.com");
  });

  it("valid Auth.js JWT for non-primary non-allowlisted user → 403 (Auth.js without CF Access)", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const jwt = await mintSessionJwt("stranger@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it("primary Auth.js session is allowed even when ALLOWED_EMAILS is empty", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const jwt = await mintSessionJwt("owner@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("owner@example.com");
  });

  it("Auth.js JWT for non-primary user → 403 even when CF_ACCESS flag is on (dual-source fix)", async () => {
    // Regression test for the identity-source confusion bug:
    // CF is configured (flag=1) but the request bypassed CF and came in with only an Auth.js
    // session cookie. The old code checked the CF flag in isEmailAllowed, which was wrong —
    // it allowed any OAuth user who bypassed CF. The fix tracks per-request fromCf=false.
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1"); // CF configured, but no CF header sent
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const jwt = await mintSessionJwt("any-oauth-user@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
      // deliberately no cf-access-authenticated-user-email header
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it("expired or tampered Auth.js session JWT → fail closed (401)", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: "authjs.session-token=invalid.tampered.token"
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("FAIL CLOSED: DB_BOOTSTRAP=live + auth unconfigured → 401 (no PRIMARY fallback)", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBeNull();
  });

  it("FAIL CLOSED: DB_BOOTSTRAP=live + auth unconfigured → redirect to /login for pages", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/console");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  // ── Test 4: authConfigured=false → PRIMARY fallback (dev/test) ───────────────
  it("no auth env (authConfigured=false) → PRIMARY_EMAIL fallback (dev/test behavior)", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "devowner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("devowner@example.com");
  });

  // ── Test 5: Forged identity headers are stripped ──────────────────────────────
  it("forged x-authenticated-user-email from client is stripped even in dev fallback", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "x-authenticated-user-email": "attacker@evil.example",
      "x-user-id": "attacker-id"
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    // The forwarded header should be the PRIMARY (override), not the attacker's value.
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("owner@example.com");
  });

  it("forged x-user-id is stripped on public paths too", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/health", {
      "x-user-id": "attacker"
    });
    const res = await middleware(req);
    // Public path always passes, but the forged header must be absent.
    expect(res.status).toBe(200);
    const fwdUserId = res.headers.get("x-middleware-request-x-user-id");
    expect(fwdUserId).toBeNull();
  });

  // ── Test 6: Public paths bypass auth entirely ──────────────────────────────────
  it("public path /api/health passes with no identity and no auth configured", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/health");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("public path /api/live passes with no identity and no auth configured", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/live");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("one-time mobile auth exchange reaches its verifier gate without an existing session", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    const res = await middleware(new NextRequest("https://trading.example.com/api/mobile/auth/exchange", {
      method: "POST",
      headers: {
        "x-authenticated-user-email": "attacker@evil.example",
        "x-user-id": "attacker-id"
      }
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-user-id")).toBeNull();
  });

  it("blocks cross-site mobile auth exchange attempts before the one-time verifier gate", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    const res = await middleware(new NextRequest("https://trading.example.com/api/mobile/auth/exchange", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" }
    }));
    expect(res.status).toBe(403);
  });

  it("/login page is public (no redirect loop)", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/login");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("Socratic Trade public site overview is public even when auth is armed", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    const req = makeRequest("/design/socratic-trade", {
      "x-authenticated-user-email": "attacker@evil.example",
      "x-user-id": "attacker-id"
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-user-id")).toBeNull();
  });

  it("crawler metadata files (robots/sitemap) are public even when auth is armed", async () => {
    // A robots.txt that 307s to /login parses as "no rules" to crawlers, so
    // every robots/noai directive silently dies. Regression for the live gap
    // found 2026-07-11: production auth-gated these metadata routes.
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    for (const path of ["/robots.txt", "/sitemap.xml"]) {
      const res = await middleware(makeRequest(path));
      expect(res.status, `${path} must not require auth`).toBe(200);
    }
  });

  it("retired PWA manifest is 410 (not an auth redirect) when auth is armed", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/manifest.webmanifest"));
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
  });

  it("PWA kill-switch worker stays public so leftover installs can update", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/sw.js"));
    expect(res.status, "/sw.js must not require auth").toBe(200);
  });

  it("Auth.js callback paths are public so provider sign-in can complete", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/auth/callback/google");
    const res = await middleware(req);
    expect(res.status).toBe(200);

    const githubReq = makeRequest("/api/auth/callback/github");
    const githubRes = await middleware(githubReq);
    expect(githubRes.status).toBe(200);
  });

  it("Robinhood OAuth start is not public; it still requires a verified app user", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/auth/robinhood/start");
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("Robinhood OAuth callback is public but strips forged identity hints", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/auth/robinhood/callback?code=abc&state=xyz", {
      "x-authenticated-user-email": "attacker@evil.example",
      "x-user-id": "attacker-id"
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-user-id")).toBeNull();
  });

  it("redirects admin.socratictrade.com / and shorthand routes to /admin", async () => {
    const middleware = await loadMiddleware();

    const rootReq = new NextRequest("https://admin.socratictrade.com/", {
      headers: { host: "admin.socratictrade.com" }
    });
    const rootRes = await middleware(rootReq);
    expect(rootRes.status).toBe(307);
    expect(rootRes.headers.get("location")).toBe("https://admin.socratictrade.com/admin");

    const serverReq = new NextRequest("https://admin.socratictrade.com/server", {
      headers: { host: "admin.socratictrade.com" }
    });
    const serverRes = await middleware(serverReq);
    expect(serverRes.status).toBe(307);
    expect(serverRes.headers.get("location")).toBe("https://admin.socratictrade.com/admin/server");
  });
});

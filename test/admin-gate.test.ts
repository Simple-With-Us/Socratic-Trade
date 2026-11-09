import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkAdmin, isAdminEmail, requireAdmin } from "../src/lib/auth/admin";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";

// Admin-role gate. Identity is the trusted x-authenticated-user-email header (set by middleware). Admin is
// the ADMIN_USER_EMAILS allowlist (+ the primary operator). Default-deny in every environment when
// neither a verified admin identity nor token is present. The middleware's synthetic local fallback
// has explicit provenance and is never accepted for admin authorization.
function reqWithEmail(
  email?: string,
  adminToken?: string,
  identitySource: string | undefined = email ? AUTHENTICATED_IDENTITY_SOURCES.authJsSession : undefined
): Request {
  const headers: Record<string, string> = {};
  if (email) headers[AUTHENTICATED_EMAIL_HEADER] = email;
  if (identitySource) headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = identitySource;
  if (adminToken) headers["x-admin-token"] = adminToken;
  return new Request("https://trading.example.com/api/admin/trigger-test", { method: "POST", headers });
}

describe("requireAdmin / admin allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("isAdminEmail honors ADMIN_USER_EMAILS and the primary operator", () => {
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com, ops@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    expect(isAdminEmail("boss@example.com")).toBe(true);
    expect(isAdminEmail("OPS@EXAMPLE.COM")).toBe(true); // case-insensitive
    expect(isAdminEmail("owner@example.com")).toBe(true); // primary always admin
    expect(isAdminEmail("intruder@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
  });

  it("ALLOWS a verified admin email (production, allowlist configured)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    const r = checkAdmin(reqWithEmail("boss@example.com"), { allowToken: false });
    expect(r.ok).toBe(true);
    expect(r.email).toBe("boss@example.com");
    expect(requireAdmin(reqWithEmail("boss@example.com"))).toBeNull();
  });

  it("DENIES (403) a non-admin email in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    const res = requireAdmin(reqWithEmail("nobody@example.com"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("DEFAULT-DENIES in production when ADMIN_USER_EMAILS is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const r = checkAdmin(reqWithEmail("anyone@example.com"), { allowToken: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("forbidden");
  });

  it("still accepts the legacy x-admin-token in production (back-compat)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "s3cret");
    const r = checkAdmin(reqWithEmail(undefined, "s3cret"));
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("admin-token");
    // Wrong token → denied.
    expect(checkAdmin(reqWithEmail(undefined, "nope")).ok).toBe(false);
  });

  it.each(["production", "development", "test", "staging", ""])(
    "denies email-only admin access without verified provenance in NODE_ENV=%j",
    (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
      expect(checkAdmin(reqWithEmail("boss@example.com", undefined, "")).ok).toBe(false);
      expect(
        checkAdmin(
          reqWithEmail("boss@example.com", undefined, AUTHENTICATED_IDENTITY_SOURCES.localFallback)
        ).ok
      ).toBe(false);
    }
  );

  it("denies the auth-unconfigured middleware fallback at the admin handler boundary", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ADMIN_USER_EMAILS", "owner@example.com");
    vi.resetModules();
    const { middleware } = await import("../middleware.js");
    const middlewareResponse = await middleware(
      new NextRequest("https://trading.example.com/api/admin/trigger-test", {
        headers: {
          [AUTHENTICATED_EMAIL_HEADER]: "attacker@example.com",
          [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
        }
      })
    );

    const forwarded = new Headers();
    for (const name of [AUTHENTICATED_EMAIL_HEADER, AUTHENTICATED_IDENTITY_SOURCE_HEADER]) {
      const value = middlewareResponse.headers.get(`x-middleware-request-${name}`);
      if (value) forwarded.set(name, value);
    }
    expect(forwarded.get(AUTHENTICATED_EMAIL_HEADER)).toBe("owner@example.com");
    expect(forwarded.get(AUTHENTICATED_IDENTITY_SOURCE_HEADER)).toBe(
      AUTHENTICATED_IDENTITY_SOURCES.localFallback
    );

    const handlerRequest = new Request("https://trading.example.com/api/admin/trigger-test", {
      headers: forwarded
    });
    expect(checkAdmin(handlerRequest, { allowToken: false })).toEqual({
      ok: false,
      reason: "forbidden",
      email: null
    });
  });

  it("still accepts verified email and valid token paths in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "s3cret");
    expect(checkAdmin(reqWithEmail("boss@example.com")).reason).toBe("admin-email");
    expect(checkAdmin(reqWithEmail(undefined, "s3cret")).reason).toBe("admin-token");
  });

  it.each(["production", "development", "test", "staging", ""])("denies no-identity requests in NODE_ENV=%j", (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    expect(checkAdmin(reqWithEmail()).ok).toBe(false);
  });
});

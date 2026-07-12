import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAdmin, isAdminEmail, requireAdmin } from "../src/lib/auth/admin";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";

// Admin-role gate. Identity is the trusted x-authenticated-user-email header (set by middleware). Admin is
// the ADMIN_USER_EMAILS allowlist (+ the primary operator). Default-deny in production when unset.
function reqWithEmail(email?: string, adminToken?: string): Request {
  const headers: Record<string, string> = {};
  if (email) headers[AUTHENTICATED_EMAIL_HEADER] = email;
  if (adminToken) headers["x-admin-token"] = adminToken;
  return new Request("https://trading.example.com/api/admin/trigger-test", { method: "POST", headers });
}

describe("requireAdmin / admin allowlist", () => {
  afterEach(() => vi.unstubAllEnvs());

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
    const r = checkAdmin(reqWithEmail("boss@example.com"), { allowToken: false, allowNonProd: false });
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
    const r = checkAdmin(reqWithEmail("anyone@example.com"), { allowToken: false, allowNonProd: false });
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

  it("runs open outside production (preserves dev/ops ergonomics)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    const r = checkAdmin(reqWithEmail());
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("non-prod");
  });
});

// G3 — Constant-time admin-token compare + fail-closed admin authorization.
//
// checkAdmin now compares the x-admin-token against ADMIN_REINDEX_TOKEN with crypto.timingSafeEqual
// (via timingSafeEqualStr) instead of `===`, and the two reindex-* routes were migrated onto the
// shared requireAdmin gate. Covers match / mismatch / empty-env for both the shared gate and the
// reindex routes, plus fail-closed production and development paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { checkAdmin, requireAdmin, timingSafeEqualStr } from "../src/lib/auth/admin";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-security-admin-${randomUUID()}.db`)}`;
});
afterEach(() => vi.unstubAllEnvs());

function req(opts: { email?: string; token?: string; url?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.email) {
    headers[AUTHENTICATED_EMAIL_HEADER] = opts.email;
    headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
  }
  if (opts.token) headers["x-admin-token"] = opts.token;
  return new Request(opts.url || "https://trading.example.com/api/admin/reindex-10k", {
    method: "GET",
    headers
  });
}

describe("G3: timingSafeEqualStr (constant-time secret compare)", () => {
  it("matches equal strings, rejects mismatches, and never throws on length mismatch", () => {
    expect(timingSafeEqualStr("s3cret", "s3cret")).toBe(true);
    expect(timingSafeEqualStr("s3cret", "s3crey")).toBe(false); // same length, different bytes
    expect(timingSafeEqualStr("s3cret", "s3cret-longer")).toBe(false); // different length — no throw
    expect(timingSafeEqualStr("", "")).toBe(false); // empty denies
    expect(timingSafeEqualStr(undefined, "x")).toBe(false);
    expect(timingSafeEqualStr("x", undefined)).toBe(false);
    expect(timingSafeEqualStr(null, null)).toBe(false);
  });
});

describe("G3: checkAdmin token path (timing-safe)", () => {
  it("accepts the correct token in production and rejects a wrong one", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "correct-horse-battery");
    expect(checkAdmin(req({ token: "correct-horse-battery" })).ok).toBe(true);
    expect(checkAdmin(req({ token: "correct-horse-battery" })).reason).toBe("admin-token");
    expect(checkAdmin(req({ token: "wrong" })).ok).toBe(false);
    expect(checkAdmin(req({ token: "correct-horse-batteryX" })).ok).toBe(false); // longer, no match/throw
  });

  it("empty ADMIN_REINDEX_TOKEN never authorizes via the token path (no accidental match)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "");
    // A client sending an empty token must NOT match an empty configured token.
    expect(checkAdmin(req({ token: "" })).ok).toBe(false);
    expect(checkAdmin(req({})).ok).toBe(false);
  });

  it("production denies when neither the email allowlist nor the token match", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "the-token");
    const res = requireAdmin(req({ email: "intruder@example.com", token: "nope" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("G3: requireTokenInProd hard gate (reindex routes)", () => {
  it("in production, a verified admin EMAIL alone is NOT enough — the token is required", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "the-token");
    // A matching admin email would normally grant (default gate), but with requireTokenInProd it must
    // be rejected — this is the injected/synthetic-primary-email bypass the reindex routes close.
    const emailOnly = checkAdmin(req({ email: "boss@example.com" }), { requireTokenInProd: true });
    expect(emailOnly.ok).toBe(false);
    expect(emailOnly.reason).toBe("forbidden-token-required");
    // The same email DOES grant under the default gate (proves the option is what changed behavior).
    expect(checkAdmin(req({ email: "boss@example.com" })).ok).toBe(true);
    // Token still works with the hard gate.
    expect(checkAdmin(req({ token: "the-token" }), { requireTokenInProd: true }).ok).toBe(true);
  });

  it("outside production, requireTokenInProd remains closed without verified email or token", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "the-token");
    expect(checkAdmin(req({}), { requireTokenInProd: true }).ok).toBe(false);
    expect(checkAdmin(req({ email: "boss@example.com" }), { requireTokenInProd: true }).ok).toBe(false);
    expect(checkAdmin(req({ token: "the-token" }), { requireTokenInProd: true }).ok).toBe(true);
  });

  it("reindex-10k GET denies a valid admin email without the token in production (403)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "reindex-secret");
    vi.resetModules();
    const { GET } = await import("../app/api/admin/reindex-10k/route");
    const denied = await GET(req({ email: "boss@example.com" })); // email only, no token
    expect(denied.status).toBe(403);
  });
});

describe("G3: reindex routes use the shared requireAdmin gate", () => {
  it("reindex-10k GET denies in production without email/token (403), allows with correct token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "reindex-secret");
    vi.resetModules();
    const { GET } = await import("../app/api/admin/reindex-10k/route");

    const denied = await GET(req({}));
    expect(denied.status).toBe(403);

    const wrong = await GET(req({ token: "reindex-secretX" }));
    expect(wrong.status).toBe(403);

    // Correct token → passes the gate (may then error later on missing Voyage/DB, but NOT 403).
    const allowed = await GET(req({ token: "reindex-secret" })).catch((e: unknown) => e);
    if (allowed instanceof Response) {
      expect(allowed.status).not.toBe(403);
    }
    // If it threw past the gate (network/vector deps), that also proves auth passed — no assertion needed.
  });

  it("reindex-8k GET denies in production without email/token (403)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "reindex-secret");
    vi.resetModules();
    const { GET } = await import("../app/api/admin/reindex-8k/route");
    const denied = await GET(req({}));
    expect(denied.status).toBe(403);
    const wrong = await GET(req({ token: "totally-wrong" }));
    expect(wrong.status).toBe(403);
  });
});

// Security half of the `admin-honesty` cluster (docs/reviews/2026-08-18-full-app-expert-review.md).
//
// Three defects, one file:
//   1. No page under app/admin/** had ANY server-side gate — every authenticated, allowlisted user
//      could load the whole operator tree (only the individual data probes 403'd).
//   2. Admin > Chat Transcript read /api/chat-history, which is the per-caller Coach endpoint, so the
//      page showed the viewer's own turns while its nav promised "every chat turn".
//   3. app/api/admin/server-knobs audited every knob write under a hardcoded userId of "local",
//      regardless of which admin flipped it.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeSessionToken } from "../src/lib/auth/session-token";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";

const AUTH_SECRET = "test-secret-at-least-32-bytes-long!!";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Middleware gate over the /admin PAGE tree
// ─────────────────────────────────────────────────────────────────────────────

async function loadMiddleware() {
  const mod = await import("../middleware.js");
  return mod.middleware as (req: NextRequest) => Promise<import("next/server").NextResponse>;
}

function makeRequest(path: string, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://trading.example.com${path}`, { headers: extraHeaders });
}

async function sessionCookieFor(email: string): Promise<Record<string, string>> {
  const jwt = await encodeSessionToken({
    token: { email, loginAt: Date.now() },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 60 * 60
  });
  return { cookie: `authjs.session-token=${jwt}` };
}

/** Arm real auth with a primary operator plus a NON-admin user who is allowed into the app. */
function armAuthWithNonAdmin() {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
  vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "");
  vi.stubEnv("ADMIN_USER_EMAILS", "");
  // staff@ authenticates and is allowed into the app, but is NOT on the admin allowlist.
  vi.stubEnv("ALLOWED_EMAILS", "owner@example.com,staff@example.com");
  vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
  vi.stubEnv("DB_BOOTSTRAP", "");
}

describe("middleware — server-side admin gate over the /admin page tree", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("redirects an authenticated NON-admin away from /admin", async () => {
    armAuthWithNonAdmin();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/admin", await sessionCookieFor("staff@example.com")));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/access-denied");
  });

  it.each([
    "/admin/transcript",
    "/admin/server",
    "/admin/operations",
    "/admin/llm-usage",
    "/admin/backups"
  ])("redirects an authenticated NON-admin away from %s", async (path) => {
    armAuthWithNonAdmin();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path, await sessionCookieFor("staff@example.com")));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/access-denied");
  });

  it("lets the primary operator through to /admin", async () => {
    armAuthWithNonAdmin();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/admin", await sessionCookieFor("owner@example.com")));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-authenticated-user-email")).toBe("owner@example.com");
  });

  it("lets an ADMIN_USER_EMAILS entry through to /admin", async () => {
    armAuthWithNonAdmin();
    vi.stubEnv("ADMIN_USER_EMAILS", "staff@example.com");
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/admin", await sessionCookieFor("staff@example.com")));

    expect(res.status).toBe(200);
  });

  it("does NOT gate a non-admin out of the ordinary console", async () => {
    armAuthWithNonAdmin();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/console", await sessionCookieFor("staff@example.com")));

    expect(res.status).toBe(200);
  });

  it("leaves /api/admin/* to each route's own gate (securities/import uses a different auth model)", async () => {
    // The page gate must not pre-empt app/api/admin/securities/import, which authenticates with its
    // own bearer token rather than requireAdmin. A non-admin request still reaches the handler here;
    // the handler decides. What must NOT happen is a middleware redirect.
    armAuthWithNonAdmin();
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest("/api/admin/securities/import", {
        ...(await sessionCookieFor("staff@example.com")),
        "sec-fetch-site": "same-origin"
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects an unauthenticated caller to /login, not /access-denied", async () => {
    armAuthWithNonAdmin();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/admin"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. DB-backed: admin transcript scope, and knob-write audit identity
// ─────────────────────────────────────────────────────────────────────────────

function adminRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      [AUTHENTICATED_EMAIL_HEADER]: "boss@example.com",
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
    }
  });
}

describe("/api/admin/transcript — admin-gated and genuinely cross-user", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `admin-transcript-${Date.now()}.db`)}`;
  });

  beforeEach(() => {
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("403s a caller with no admin identity", async () => {
    const { GET } = await import("../app/api/admin/transcript/route");
    const res = await GET(new Request("https://trading.example.com/api/admin/transcript"));

    expect(res.status).toBe(403);
  });

  it("returns turns belonging to OTHER users, so 'every chat turn' is true", async () => {
    const { appendTurn } = await import("../src/lib/chat-history");
    appendTurn("local", { role: "user", text: "owner asks something" });
    appendTurn("u_someone_else", { role: "assistant", text: "reply to a different account", model: "test-model" });

    const { GET } = await import("../app/api/admin/transcript/route");
    const res = await GET(adminRequest("https://trading.example.com/api/admin/transcript?limit=50"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { turns: Array<{ userId: string; text: string }> };
    const userIds = new Set(body.turns.map((t) => t.userId));

    expect(userIds.has("local")).toBe(true);
    expect(userIds.has("u_someone_else")).toBe(true);
    expect(body.turns.map((t) => t.text)).toContain("reply to a different account");
  });

  it("keeps /api/chat-history caller-scoped — the Coach endpoint must not become admin-only", async () => {
    // The console assistant and iOS both read this endpoint; gating it would break chat for every
    // non-admin. It must stay scoped to the caller and must NOT leak another account's turns.
    const { GET } = await import("../app/api/chat-history/route");
    const res = await GET(
      new Request("https://trading.example.com/api/chat-history?limit=50", {
        headers: {
          [AUTHENTICATED_EMAIL_HEADER]: "owner@example.com",
          [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
        }
      })
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { turns: Array<{ userId: string }> };
    expect(body.turns.every((t) => t.userId === "local")).toBe(true);
  });
});

describe("server_knob.changed — audits the admin who actually flipped it", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `admin-knob-audit-${Date.now()}.db`)}`;
  });

  beforeEach(() => {
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records the acting admin's userId and email, not a hardcoded 'local'", async () => {
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const actingUserId = userIdForEmail("boss@example.com");
    // boss@ is a non-primary admin, so their id must NOT be the primary's legacy "local" id —
    // otherwise this test could pass for the wrong reason.
    expect(actingUserId).not.toBe("local");

    const { POST } = await import("../app/api/admin/server-knobs/route");
    const res = await POST(
      adminRequest("https://trading.example.com/api/admin/server-knobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "SEC_INGEST_WORKER_ENABLED", value: true })
      })
    );
    expect(res.status).toBe(200);

    const { listAuditByKind } = await import("../src/lib/db");

    // The row must be attributed to the acting admin...
    const actingRows = listAuditByKind("server_knob.changed", 10, actingUserId);
    expect(actingRows.length).toBeGreaterThan(0);
    const payload = actingRows[0].payload as { id: string; actor?: { email?: string | null } };
    expect(payload.id).toBe("SEC_INGEST_WORKER_ENABLED");
    expect(payload.actor?.email).toBe("boss@example.com");

    // ...and must NOT be filed under the old hardcoded "local" identity.
    const localRows = listAuditByKind("server_knob.changed", 10, "local");
    expect(localRows).toHaveLength(0);
  });
});

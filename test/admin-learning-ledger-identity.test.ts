import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATED_EMAIL_HEADER,
  VERIFIED_IDENTITY_REQUIRED_ERROR
} from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";

describe("admin learning-ledger identity handling (ST-4610)", () => {
  let originalDatabaseUrl: string | undefined;

  beforeAll(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-st-4610-ledger-${randomUUID()}.db`)}`;
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function adminTokenRequest(method: "GET" | "POST", token: string, email?: string): Request {
    const headers: Record<string, string> = { "x-admin-token": token };
    if (email) {
      headers[AUTHENTICATED_EMAIL_HEADER] = email;
      headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
    }
    return new Request("https://socratictrade.com/api/admin/learning-ledger", {
      method,
      headers: method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
      body: method === "POST" ? "{}" : undefined
    });
  }

  it("returns 401 JSON for x-admin-token without verified email under live bootstrap", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "test-admin-token");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");

    const { GET, POST } = await import("../app/api/admin/learning-ledger/route");

    for (const method of ["GET", "POST"] as const) {
      const response = await (method === "GET" ? GET : POST)(
        adminTokenRequest(method, "test-admin-token")
      );
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual({
        ok: false,
        error: VERIFIED_IDENTITY_REQUIRED_ERROR,
        reason: expect.stringMatching(/live bootstrap/i)
      });
    }
  });

  it("still serves verified admin email callers", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");

    const { GET } = await import("../app/api/admin/learning-ledger/route");
    const response = await GET(adminTokenRequest("GET", "wrong-token", "boss@example.com"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("denies non-admin callers before identity resolution", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "test-admin-token");
    vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");

    const { GET } = await import("../app/api/admin/learning-ledger/route");
    const response = await GET(
      new Request("https://socratictrade.com/api/admin/learning-ledger", {
        headers: {
          [AUTHENTICATED_EMAIL_HEADER]: "stranger@example.com",
          [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
        }
      })
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Forbidden/i);
  });
});

describe("audit route identity handling (ST-4610)", () => {
  let originalDatabaseUrl: string | undefined;

  beforeAll(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-st-4610-audit-${randomUUID()}.db`)}`;
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 JSON without verified identity in live bootstrap", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    const { GET } = await import("../app/api/audit/route");
    const response = await GET(new Request("https://socratictrade.com/api/audit"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe(VERIFIED_IDENTITY_REQUIRED_ERROR);
  });
});

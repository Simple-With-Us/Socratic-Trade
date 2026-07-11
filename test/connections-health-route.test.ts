import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES,
} from "../src/lib/auth/strip-identity";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `connections-health-route-${randomUUID()}.db`)}`;
});

async function load() {
  const db = await import("../src/lib/db");
  const route = await import("../app/api/admin/connections-health/route");
  return { db, route };
}

function authenticatedAdminRequest(): Request {
  return new Request("https://socratictrade.com/api/admin/connections-health", {
    headers: {
      [AUTHENTICATED_EMAIL_HEADER]: "admin@example.com",
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession,
    },
  });
}

describe("connections-health API route", () => {
  beforeEach(async () => {
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    const { db } = await load();
    db.getDb().prepare("DELETE FROM api_health_log").run();
    db.getDb().prepare("DELETE FROM api_health_error_patterns").run();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns exactly one canonical Alpha Vantage env lane without a phantom legacy spelling", async () => {
    const { db, route } = await load();
    db.logApiHealth({ service: "alpha-vantage", ok: true, latencyMs: 125, keySource: "env" });

    const response = await route.GET(authenticatedAdminRequest());

    expect(response.status).toBe(200);
    const body = await response.json() as {
      services: Array<{ service: string; keySource: string | null; lastSuccessTs: string | null }>;
    };
    const canonicalLanes = body.services.filter(
      (lane) => lane.service === "alpha-vantage" && lane.keySource === "env",
    );

    expect(canonicalLanes).toHaveLength(1);
    expect(canonicalLanes[0]?.lastSuccessTs).not.toBeNull();
    expect(body.services.some((lane) => lane.service === "alphavantage")).toBe(false);
  });
});

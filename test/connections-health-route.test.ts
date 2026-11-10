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

  it("expects env lane for shared-operator-infra even when local user has a key", async () => {
    const { db, route } = await load();
    db.upsertUserApiKey("local", "alphavantage", "local-av-key");

    const response = await route.GET(authenticatedAdminRequest());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      services: Array<{ service: string; keySource: string | null }>;
    };
    const avLanes = body.services.filter((lane) => lane.service === "alpha-vantage");
    // It should have the env lane (keySource: "env"), not user lane (keySource: "user")
    expect(avLanes).toHaveLength(1);
    expect(avLanes[0]?.keySource).toBe("env");
  });

  it("marks FMP as intentional OFF (not stopped) even with consecutive failure rows", async () => {
    const { db, route } = await load();
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({
        service: "fmp",
        ok: false,
        errorText: "403 subscription suspended",
        keySource: "env",
      });
    }

    const response = await route.GET(authenticatedAdminRequest());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      services: Array<{
        service: string;
        keySource: string | null;
        intentionalOff?: boolean;
        stoppedWorking: boolean;
        stoppedReason: string | null;
      }>;
    };
    const fmpLanes = body.services.filter((lane) => lane.service === "fmp");
    expect(fmpLanes.length).toBeGreaterThanOrEqual(1);
    for (const lane of fmpLanes) {
      expect(lane.intentionalOff).toBe(true);
      expect(lane.stoppedWorking).toBe(false);
      expect(lane.stoppedReason).toMatch(/retired|Congress\.Trade/i);
    }
  });

  it("canonicalizes producer earningscalls logs onto the expected RapidAPI lane", async () => {
    const { db, route } = await load();
    db.logApiHealth({ service: "earningscalls", ok: true, latencyMs: 40, keySource: "env" });
    db.logApiHealth({
      service: "earningscalls-dev-rapidapi",
      ok: true,
      latencyMs: 55,
      keySource: "env",
    });

    const response = await route.GET(authenticatedAdminRequest());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      services: Array<{ service: string; keySource: string | null; lastSuccessTs: string | null }>;
    };
    const earningsLanes = body.services.filter((lane) =>
      lane.service === "earningscalls" ||
      lane.service === "earningscalls-dev-rapidapi" ||
      lane.service === "earningscall"
    );

    expect(earningsLanes).toHaveLength(1);
    expect(earningsLanes[0]?.service).toBe("earningscalls-dev-rapidapi");
    expect(earningsLanes[0]?.keySource).toBe("env");
    expect(earningsLanes[0]?.lastSuccessTs).not.toBeNull();
  });

  it("merges canonical detail logs and error patterns across producer aliases", async () => {
    const { db, route } = await load();
    db.logApiHealth({ service: "earningscalls", ok: false, errorText: "producer failed", keySource: "env" });
    db.logApiHealth({ service: "earningscalls-dev-rapidapi", ok: true, latencyMs: 55, keySource: "env" });

    const summaryResponse = await route.GET(authenticatedAdminRequest());
    const summary = await summaryResponse.json() as {
      errorPatterns: Record<string, Array<{ service: string; error_text: string }>>;
    };
    expect(summary.errorPatterns["earningscalls-dev-rapidapi:env"]).toEqual([
      expect.objectContaining({ service: "earningscalls-dev-rapidapi", error_text: "producer failed" }),
    ]);

    const detailResponse = await route.GET(new Request(
      "https://socratictrade.com/api/admin/connections-health?service=earningscalls-dev-rapidapi&keySource=env",
      { headers: authenticatedAdminRequest().headers },
    ));
    const detail = await detailResponse.json() as { log: Array<{ service: string; ok: number }> };
    expect(detail.log).toHaveLength(2);
    expect(detail.log.map((row) => row.service).sort()).toEqual([
      "earningscalls",
      "earningscalls-dev-rapidapi",
    ]);
  });

  it("recomputes stopped state from the combined chronological alias log", async () => {
    const { db, route } = await load();
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "earningscalls", ok: false, errorText: `legacy failure ${i}`, keySource: "env" });
    }
    db.getDb().prepare(
      "UPDATE api_health_log SET ts = '2026-08-29T00:00:00.000Z' WHERE service = 'earningscalls'",
    ).run();
    db.logApiHealth({ service: "earningscalls-dev-rapidapi", ok: true, latencyMs: 40, keySource: "env" });

    const response = await route.GET(authenticatedAdminRequest());
    const body = await response.json() as {
      services: Array<{ service: string; stoppedWorking: boolean; stoppedReason: string | null }>;
    };
    const lane = body.services.find((service) => service.service === "earningscalls-dev-rapidapi");
    expect(lane?.stoppedWorking).toBe(false);
    expect(lane?.stoppedReason).toBeNull();
  });

  it("marks historical quiverquant log lanes intentional OFF", async () => {
    const { db, route } = await load();
    db.logApiHealth({
      service: "quiverquant",
      ok: false,
      errorText: "retired",
      keySource: "env",
    });

    const response = await route.GET(authenticatedAdminRequest());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      services: Array<{ service: string; intentionalOff?: boolean; stoppedWorking: boolean }>;
    };
    const quiver = body.services.filter((lane) => lane.service === "quiverquant");
    expect(quiver.length).toBe(1);
    expect(quiver[0]?.intentionalOff).toBe(true);
    expect(quiver[0]?.stoppedWorking).toBe(false);
  });
});

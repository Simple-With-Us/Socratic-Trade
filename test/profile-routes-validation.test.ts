import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ST-4610 Kody follow-ups: POST /api/profiles validates a strict envelope before it reaches the
// database, and POST /api/profiles/[id]/activate answers only a missing profile (404) and lets server faults surface as 500s.

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", `file:${join(tmpdir(), `agentic-profile-routes-${randomUUID()}.db`)}`);
});

afterEach(() => {
  vi.doUnmock("@/lib/request-user");
  vi.doUnmock("@/lib/db");
  vi.unstubAllEnvs();
});

function postProfiles(body: unknown): Request {
  return new Request("http://localhost/api/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/profiles strict payload", () => {
  it("rejects unknown keys with HTTP 400 and persists nothing", async () => {
    const { POST } = await import("../app/api/profiles/route");
    const response = await POST(postProfiles({ name: "Momentum", userId: "someone-else" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid profile payload" });
    const { listStrategyProfiles } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    expect(listStrategyProfiles(DEFAULT_REQUEST_USER_ID).some((p) => p.name === "Momentum")).toBe(false);
  });

  it.each([
    ["non-string name", { name: 42 }],
    ["non-string prompt", { prompt: ["x"] }],
    ["non-object policy", { policy: "aggressive" }],
    ["non-boolean active", { active: "yes" }],
    ["array body", ["Momentum"]]
  ])("rejects a %s with HTTP 400", async (_label, body) => {
    const { POST } = await import("../app/api/profiles/route");
    const response = await POST(postProfiles(body));
    expect(response.status).toBe(400);
  });

  it("creates a profile from the parsed fields only", async () => {
    const { POST } = await import("../app/api/profiles/route");
    const response = await POST(postProfiles({ name: "  Swing  ", prompt: "Be patient.", active: true }));
    expect(response.status).toBe(200);
    const profile = (await response.json()) as { name: string; prompt: string; active: boolean };
    expect(profile).toMatchObject({ name: "Swing", prompt: "Be patient.", active: true });

    const blank = await POST(postProfiles({ name: "   " }));
    expect(blank.status).toBe(200);
    await expect(blank.json()).resolves.toMatchObject({ name: "New Strategy", active: false });
  });
});

describe("POST /api/profiles/[id]/activate error mapping", () => {
  function activate(id: string): Request {
    return new Request(`http://localhost/api/profiles/${id}/activate`, { method: "POST" });
  }

  it("lets a user-resolution server fault escape as a 500 instead of a 400 with internal text", async () => {
    vi.doMock("@/lib/request-user", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/request-user")>()),
      resolveRequestUserIdOrResponse: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      }
    }));
    const { POST } = await import("../app/api/profiles/[id]/activate/route");
    await expect(POST(activate("p1"), { params: Promise.resolve({ id: "p1" }) })).rejects.toThrow(/SQLITE_BUSY/);
  });

  it.each([
    ["Code CLI mode", "CODE_CLI_ENABLED", "true", /Code CLI/],
    ["live bootstrap", "DB_BOOTSTRAP", "live", /live bootstrap/]
  ])("returns the verified_identity_required 401 unchanged under %s", async (_label, name, value, reason) => {
    vi.stubEnv(name, value);
    const { POST } = await import("../app/api/profiles/[id]/activate/route");
    const response = await POST(activate("p1"), { params: Promise.resolve({ id: "p1" }) });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "verified_identity_required",
      reason: expect.stringMatching(reason)
    });
  });

  it("maps a missing profile to HTTP 404", async () => {
    const { POST } = await import("../app/api/profiles/[id]/activate/route");
    const response = await POST(activate("missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Strategy profile not found.");
  });

  it("lets an activation server fault escape as a 500 instead of a 400 with internal text", async () => {
    vi.doMock("@/lib/db", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/db")>()),
      activateStrategyProfile: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      }
    }));
    const { POST } = await import("../app/api/profiles/[id]/activate/route");
    await expect(POST(activate("p1"), { params: Promise.resolve({ id: "p1" }) })).rejects.toThrow(/SQLITE_BUSY/);
  });

  // The route resolves the request user itself (DEV_USER_ID, defaulting to "local"), so the fixture
  // is created under the same DEFAULT_REQUEST_USER_ID whether or not DEV_USER_ID is set.
  it.each([
    ["DEV_USER_ID unset", undefined, "local"],
    ["DEV_USER_ID set", "dev-fixture-user", "dev-fixture-user"]
  ])("activates an existing profile with %s", async (_label, devUserId, expectedUserId) => {
    vi.stubEnv("DEV_USER_ID", devUserId);
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    expect(DEFAULT_REQUEST_USER_ID).toBe(expectedUserId);
    const { createStrategyProfile } = await import("../src/lib/db");
    const created = createStrategyProfile({ name: "Swing" }, DEFAULT_REQUEST_USER_ID);
    const { POST } = await import("../app/api/profiles/[id]/activate/route");
    const response = await POST(activate(created.id), { params: Promise.resolve({ id: created.id }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: created.id, active: true });
  });
});

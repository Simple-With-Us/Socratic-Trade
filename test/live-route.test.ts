import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-live-route-${randomUUID()}.db`)}`;
});

async function load() {
  const db = await import("../src/lib/db");
  const liveRoute = await import("../app/api/live/route");
  const healthRoute = await import("../app/api/health/route");
  return { db, liveRoute, healthRoute };
}

describe("/api/live", () => {
  beforeEach(async () => {
    const { db } = await load();
    db.getDb().prepare("DELETE FROM settings").run();
    db.getDb().prepare("DELETE FROM api_health_log").run();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
  });

  afterEach(async () => {
    const { db } = await load();
    db.getDb().prepare("DELETE FROM api_health_log").run();
  });

  it("returns 200 when SQLite is readable", async () => {
    const { liveRoute } = await load();
    const response = await liveRoute.GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, probe: "live" });
  });

  it("returns 200 when the serving SQLite handle is closed", async () => {
    const { db, liveRoute } = await load();
    db.getDb().close();
    try {
      const started = Date.now();
      const response = await liveRoute.GET();
      expect(Date.now() - started).toBeLessThan(200);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, probe: "live" });
    } finally {
      db.resetDbForTesting();
    }
  });

  it("stays 200 when /api/health would 503 on a hard-stopped critical dependency", async () => {
    const { db, liveRoute, healthRoute } = await load();
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Global Error", keySource: "env" });
    }
    const live = await liveRoute.GET();
    expect(live.status).toBe(200);
    const health = await healthRoute.GET(new Request("http://localhost/api/health"));
    expect(health.status).toBe(503);
  });
});

describe("Coolify Traefik liveness wiring", () => {
  it("points Docker HEALTHCHECK at /api/live, not /api/health", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*4000\/api\/live/);
    expect(dockerfile).not.toMatch(/HEALTHCHECK[\s\S]*4000\/api\/health/);
    expect(existsSync(join(repoRoot, "app/api/live/route.ts"))).toBe(true);
  });
});

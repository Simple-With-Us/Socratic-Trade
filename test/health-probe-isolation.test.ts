import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Sentry uptime (SOCRATIC-TRADE-S) times out GET /api/health at ~8s.
 * A warm probe must return from memory: a long synchronous SQLite call and a
 * hung credit fetch run only on the background refresh, after the response.
 */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-probe-${randomUUID()}.db`)}`;
});

const HEALTH_URL = "http://localhost/api/health";

async function load() {
  const db = await import("../src/lib/db");
  const healthRoute = await import("../app/api/health/route");
  const cache = await import("../src/lib/health-probe-cache");
  return { db, healthRoute, cache };
}

describe("health probe isolation", () => {
  const originals: {
    summaries?: typeof import("../src/lib/health-probe-cache").healthProbeDeps.getServiceHealthSummaries;
    credits?: typeof import("../src/lib/health-probe-cache").healthProbeDeps.getOpenRouterCreditStatus;
  } = {};

  beforeEach(async () => {
    process.env.HEALTH_SNAPSHOT_TTL_MS = "60000";
    const { db, cache } = await load();
    cache.__resetHealthSnapshotForTests();
    originals.summaries = cache.healthProbeDeps.getServiceHealthSummaries;
    originals.credits = cache.healthProbeDeps.getOpenRouterCreditStatus;
    db.getDb().prepare("DELETE FROM settings").run();
    db.getDb().prepare("DELETE FROM api_health_log").run();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
  });

  afterEach(async () => {
    const { cache } = await load();
    if (originals.summaries) cache.healthProbeDeps.getServiceHealthSummaries = originals.summaries;
    if (originals.credits) cache.healthProbeDeps.getOpenRouterCreditStatus = originals.credits;
    cache.__resetHealthSnapshotForTests();
    delete process.env.HEALTH_SNAPSHOT_TTL_MS;
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("does not run a simulated long sync DB read on a warm /api/health", async () => {
    const { healthRoute, cache } = await load();
    const prime = await healthRoute.GET(new Request(HEALTH_URL));
    expect(prime.status).toBe(200);

    let calls = 0;
    cache.healthProbeDeps.getServiceHealthSummaries = () => {
      calls += 1;
      const started = Date.now();
      while (Date.now() - started < 400) {
        // Stand-in for a better-sqlite3 call that pins the serving thread.
      }
      return [];
    };

    const started = Date.now();
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(Date.now() - started).toBeLessThan(150);
    expect(calls).toBe(0);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.checks.db).toBe("ok");
    expect(typeof body.checks.schedulerStale).toBe("boolean");
  });

  it("does not wait on a hung OpenRouter credit fetch on a warm /api/health", async () => {
    const { healthRoute, cache } = await load();
    const prime = await healthRoute.GET(new Request(HEALTH_URL));
    expect(prime.status).toBe(200);

    let calls = 0;
    let release: (value: null) => void = () => {};
    const hung = new Promise<null>((resolve) => {
      release = resolve;
    });
    cache.healthProbeDeps.getOpenRouterCreditStatus = () => {
      calls += 1;
      return hung;
    };

    try {
      const started = Date.now();
      const response = await healthRoute.GET(new Request(HEALTH_URL));
      expect(Date.now() - started).toBeLessThan(150);
      expect(calls).toBe(0);
      expect(response.status).toBe(200);
    } finally {
      release(null);
    }
  });

  it("returns the last snapshot when a refresh is in flight behind a slow dependency", async () => {
    const { healthRoute, cache } = await load();
    const prime = await healthRoute.GET(new Request(HEALTH_URL));
    expect(prime.status).toBe(200);
    const primed = await prime.json();

    process.env.HEALTH_SNAPSHOT_TTL_MS = "1";
    await new Promise((resolve) => setTimeout(resolve, 5));

    let release: (value: null) => void = () => {};
    const hung = new Promise<null>((resolve) => {
      release = resolve;
    });
    cache.healthProbeDeps.getOpenRouterCreditStatus = () => hung;

    try {
      const started = Date.now();
      const response = await healthRoute.GET(new Request(HEALTH_URL));
      expect(Date.now() - started).toBeLessThan(150);
      expect(response.status).toBe(primed.ok ? 200 : 503);
      const body = await response.json();
      expect(body.checks.db).toBe("ok");
      expect(body.checks.schedulerStale).toBe(primed.checks.schedulerStale);
    } finally {
      if (originals.credits) cache.healthProbeDeps.getOpenRouterCreditStatus = originals.credits;
      release(null);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});

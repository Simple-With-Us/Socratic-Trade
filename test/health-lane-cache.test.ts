import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// ST-4635: listHealthLanes used `SELECT DISTINCT service, key_source FROM api_health_log`, a
// full covering-index walk that held the prod event loop 15.9-18.8s over 1.8M rows and tripped
// the host health watchdog.  It now loads lanes with a loose index scan and caches them per
// connection.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-lane-cache-${randomUUID()}.db`)}`;
});

afterEach(() => {
  delete process.env.HEALTH_LANE_CACHE_TTL_MS;
});

async function load() {
  const health = await import("../src/lib/db-health");
  const { getDb } = await import("../src/lib/db");
  return { ...health, getDb };
}

function insertRow(db: Database.Database, service: string, keySource: string | null) {
  db.prepare(
    "INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id) VALUES (?, ?, ?, 1, 5, NULL, ?, NULL)"
  ).run(randomUUID(), service, new Date().toISOString(), keySource);
}

describe("health lane listing", () => {
  it("returns exactly the DISTINCT (service, key_source) lanes, in the same order", async () => {
    const { getDb, loadHealthLanesFromDb } = await load();
    const db = getDb();
    const prefix = `lane-order-${randomUUID().slice(0, 8)}`;
    for (const [service, keySource] of [
      [`${prefix}-b`, "user"],
      [`${prefix}-a`, "env"],
      [`${prefix}-a`, null],
      [`${prefix}-b`, null],
      [`${prefix}-a`, "env"],
      [`${prefix}-a`, "user"],
      [`${prefix}-c`, "env"]
    ] as Array<[string, string | null]>) {
      insertRow(db, service, keySource);
    }

    const distinct = db
      .prepare("SELECT DISTINCT service, key_source FROM api_health_log ORDER BY service, key_source")
      .all();
    expect(loadHealthLanesFromDb(db)).toEqual(distinct);
  });

  it("seeks the (service, key_source, ts) index instead of scanning api_health_log", async () => {
    const { getDb } = await load();
    const db = getDb();
    const statements: Array<[string, unknown[]]> = [
      ["SELECT MIN(service) AS service FROM api_health_log", []],
      ["SELECT MIN(service) AS service FROM api_health_log WHERE service > ?", ["a"]],
      ["SELECT 1 AS hit FROM api_health_log WHERE service = ? AND key_source IS NULL LIMIT 1", ["a"]],
      ["SELECT MIN(key_source) AS key_source FROM api_health_log WHERE service = ? AND key_source IS NOT NULL", ["a"]],
      ["SELECT MIN(key_source) AS key_source FROM api_health_log WHERE service = ? AND key_source > ?", ["a", "b"]]
    ];
    for (const [sql, params] of statements) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
      expect(plan, sql).toMatch(/^SEARCH api_health_log USING COVERING INDEX idx_api_health_log_service_(ts|key)/);
      expect(plan, sql).not.toMatch(/SCAN/);
    }
  });

  it("serves cached lanes between refreshes but still shows a lane the writer just logged", async () => {
    process.env.HEALTH_LANE_CACHE_TTL_MS = "600000";
    const { getDb, getServiceHealthSummaries, invalidateHealthLaneCache, logApiHealth } = await load();
    const db = getDb();
    invalidateHealthLaneCache();
    const seeded = `lane-cache-seed-${randomUUID().slice(0, 8)}`;
    insertRow(db, seeded, "env");
    expect(getServiceHealthSummaries().some((s) => s.service === seeded)).toBe(true);

    // A row written behind the writer's back is not visible until the cache refreshes: proof the
    // listing no longer re-reads api_health_log on every call.
    const external = `lane-cache-external-${randomUUID().slice(0, 8)}`;
    insertRow(db, external, "env");
    expect(getServiceHealthSummaries().some((s) => s.service === external)).toBe(false);

    // The production writer (logApiHealth -> flushApiHealthBuffer) updates the cache itself.
    const logged = `lane-cache-logged-${randomUUID().slice(0, 8)}`;
    logApiHealth({ service: logged, ok: true, latencyMs: 5, keySource: "user" });
    const loggedSummary = getServiceHealthSummaries().find((s) => s.service === logged);
    expect(loggedSummary?.keySource).toBe("user");
    expect(loggedSummary?.callsLastHour).toBe(1);

    invalidateHealthLaneCache();
    expect(getServiceHealthSummaries().some((s) => s.service === external)).toBe(true);
  });

  it("re-reads the table on every call when the TTL is 0", async () => {
    process.env.HEALTH_LANE_CACHE_TTL_MS = "0";
    const { getDb, getServiceHealthSummaries } = await load();
    const db = getDb();
    getServiceHealthSummaries();
    const service = `lane-ttl-zero-${randomUUID().slice(0, 8)}`;
    insertRow(db, service, null);
    expect(getServiceHealthSummaries().find((s) => s.service === service)?.keySource ?? null).toBeNull();
  });
});

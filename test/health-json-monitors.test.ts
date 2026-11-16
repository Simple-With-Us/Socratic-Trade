import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Pins the UptimeRobot/Pushover contract: three JSON flags are always present,
 * those flags never 503 `/api/health`, and pinecone / alpaca-broker stay critical.
 * Does not rewrite rag-embed degrade.
 */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-json-monitors-${randomUUID()}.db`)}`;
});

const HEALTH_URL = "http://localhost/api/health";

async function load() {
  const db = await import("../src/lib/db");
  const healthRoute = await import("../app/api/health/route");
  return { db, healthRoute };
}

async function seedFreshTick() {
  const { db } = await load();
  db.getDb().prepare("DELETE FROM settings").run();
  db.getDb().prepare("DELETE FROM api_health_log").run();
  db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
}

describe("/api/health JSON monitor fields", () => {
  beforeEach(async () => {
    await seedFreshTick();
  });

  afterEach(() => {
    delete process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES;
  });

  it("always emits schedulerStale, tradingLiveness.degraded, and litestreamTiersDegraded", async () => {
    const { healthRoute } = await load();
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw);

    expect(body.ok).toBe(true);
    expect(body.checks.schedulerStale).toBe(false);
    expect(typeof body.checks.tradingLiveness.degraded).toBe("number");
    expect(body.checks.tradingLiveness.degraded).toBe(0);
    expect(body.checks.tradingLivenessDegraded).toBe(false);
    expect(typeof body.checks.storage.litestreamTiersDegraded).toBe("boolean");

    expect(raw).toContain('"schedulerStale":false');
    expect(raw).toContain('"tradingLivenessDegraded":false');
    expect(raw).toContain('"litestreamTiersDegraded":');
  });

  it("keeps a trading-liveness episode when the liveness result is unknown (no summary)", async () => {
    const { db, healthRoute } = await load();
    const since = new Date(Date.now() - 9 * 3_600_000).toISOString();
    db.setInternalSetting("livenessDegradedSince:trading_liveness_degraded", since);
    db.setInternalSetting("livenessEscalatedAt:trading_liveness_degraded", since);
    // No active-autonomy accounts in this DB: the summary is null, which is
    // "unknown", not "recovered".
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.getInternalSetting<string>("livenessDegradedSince:trading_liveness_degraded")).toBe(since);
    expect(db.getInternalSetting<string>("livenessEscalatedAt:trading_liveness_degraded")).toBe(since);
  });

  it("stays HTTP 200 when schedulerStale is true", async () => {
    const { db, healthRoute } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date(Date.now() - 10 * 60_000).toISOString());

    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(body.ok).toBe(true);
    expect(body.checks.schedulerStale).toBe(true);
    expect(raw).toContain('"schedulerStale":true');
  });

  it("stays HTTP 200 when tradingLiveness.degraded is above zero", async () => {
    process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES = "1";
    const { db, healthRoute } = await load();
    const userId = `mon-user-${randomUUID()}`;
    const accountId = `mon-acct-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `ACC-${randomUUID().slice(0, 8)}`,
      label: "Monitor Account",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active" }, userId, accountId);
    db.getDb()
      .prepare(
        `INSERT INTO strategy_runs (id, user_id, connected_account_id, started_at, finished_at, status, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        userId,
        accountId,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        "failed",
        "failed"
      );

    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(body.ok).toBe(true);
    expect(body.checks.tradingLiveness.degraded).toBeGreaterThan(0);
    expect(body.checks.tradingLivenessDegraded).toBe(true);
    expect(raw).toContain('"tradingLivenessDegraded":true');
  });

  it("still 503s when pinecone is hard-stopped", async () => {
    const { db, healthRoute } = await load();
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Global Error", keySource: "env" });
    }
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.dependencies.pinecone.ok).toBe(false);
    expect(body.checks.schedulerStale).toBe(false);
    expect(typeof body.checks.tradingLiveness.degraded).toBe("number");
    expect(typeof body.checks.storage.litestreamTiersDegraded).toBe("boolean");
  });

  it("still 503s when alpaca-broker is hard-stopped with no healthy user lane", async () => {
    const { db, healthRoute } = await load();
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({
        service: "alpaca-broker",
        ok: false,
        errorText: "Request failed with status code 401",
        keySource: "env"
      });
    }
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.dependencies["alpaca-broker"].ok).toBe(false);
  });
});

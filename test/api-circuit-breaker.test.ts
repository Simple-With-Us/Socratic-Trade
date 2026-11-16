import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Isolated temp SQLite per file (db singleton state must not leak across files).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-breaker-${randomUUID()}.db`)}`;
});

async function load() {
  const health = await import("../src/lib/db-health");
  const breaker = await import("../src/lib/api-circuit-breaker");
  return { ...health, ...breaker };
}

/** Seed n consecutive failing health rows for a (service, keySource) lane. */
async function seedFailures(service: string, keySource: string, n: number) {
  const { logApiHealth } = await load();
  for (let i = 0; i < n; i++) {
    logApiHealth({ service, ok: false, errorText: "HTTP 500", keySource });
  }
}

describe("getLaneHealth — per (service, keySource) lane", () => {
  beforeEach(async () => {
    (await load()).resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    delete process.env.API_CIRCUIT_BREAKER_BACKOFF_MS;
  });

  it("trips a lane after 5 consecutive failures without touching a sibling lane of the same service", async () => {
    const { getLaneHealth } = await load();
    await seedFailures("finnhub-iso", "user", 5);
    expect(getLaneHealth("finnhub-iso", "user").stoppedWorking).toBe(true);
    // The operator/env lane of the SAME service has no failures — it must NOT be tripped.
    expect(getLaneHealth("finnhub-iso", "env").stoppedWorking).toBe(false);
  });

  it("is not tripped with no history", async () => {
    const { getLaneHealth } = await load();
    expect(getLaneHealth("never-called", "user").stoppedWorking).toBe(false);
  });
});

describe("ts-tie tiebreaker — same-millisecond api_health_log rows", () => {
  // logApiHealth() always stamps `new Date().toISOString()`, so it can't reproduce a same-ts
  // collision on its own. Insert rows directly with an IDENTICAL ts and a KNOWN insertion order
  // (ascending rowid) to prove reads are ordered by insertion (newest inserted first), not left to
  // SQLite's tie-order (which — absent a `rowid DESC` tiebreaker — resolves ties in ascending
  // rowid/scan order, i.e. OLDEST-first: the exact bug this sweep fixes).
  it("last-5 window and last-ok/last-fail reads return insertion order, not ts-tie scan order", async () => {
    const { getLaneHealth } = await load();
    const { getDb } = await import("../src/lib/db");
    const { randomUUID: uuid } = await import("node:crypto");
    const db = getDb();
    const service = "tie-sweep-svc";
    const keySource = "user";
    const sharedTs = "2026-07-10T12:00:00.000Z";

    // Insertion order (ascending rowid): success, success, fail, fail, fail, fail, fail.
    // The most-recently-inserted 5 rows (r3..r7) are ALL failures — the breaker must trip.
    // A ts-only ORDER BY (ties resolved by ascending scan order) would instead return the
    // OLDEST 5 rows (r1..r5 = 2 successes + 3 fails) and wrongly report the lane as healthy.
    const okPattern = [1, 1, 0, 0, 0, 0, 0];
    for (const ok of okPattern) {
      db.prepare(
        `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), service, sharedTs, ok, null, ok ? null : "HTTP 500", keySource, null);
    }

    const result = getLaneHealth(service, keySource);
    // r3..r7 (last 5 inserted) are all failures -> consecutive-failure breaker trips.
    expect(result.stoppedWorking).toBe(true);
    expect(result.reason).toContain("5 consecutive calls all failed");

    // lastFailureTs sanity: with a single shared ts, the ONLY thing an ordering bug could get
    // wrong here is *which* row's ts is picked when ties race — same value either way — so the
    // meaningful assertion is the stoppedWorking verdict above, which depends on picking the
    // newest-inserted 5 rows specifically.
    expect(result.lastFailureTs).toBe(sharedTs);
  });

  it("getServiceHealthSummaries agrees with getLaneHealth on the same tie-heavy lane", async () => {
    const { getServiceHealthSummaries } = await load();
    const { getDb } = await import("../src/lib/db");
    const { randomUUID: uuid } = await import("node:crypto");
    const db = getDb();
    const service = "tie-sweep-summary-svc";
    const keySource = "env";
    const sharedTs = "2026-07-10T12:00:00.000Z";

    const okPattern = [1, 1, 0, 0, 0, 0, 0];
    for (const ok of okPattern) {
      db.prepare(
        `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), service, sharedTs, ok, null, ok ? null : "HTTP 500", keySource, null);
    }

    const summaries = await getServiceHealthSummaries();
    const summary = summaries.find((s) => s.service === service && s.keySource === keySource);
    expect(summary).toBeDefined();
    expect(summary?.stoppedWorking).toBe(true);
  });
});

describe("apiCircuitBreakerShouldSkip", () => {
  beforeEach(async () => {
    (await load()).resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    delete process.env.API_CIRCUIT_BREAKER_BACKOFF_MS;
  });
  afterEach(() => {
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    delete process.env.API_CIRCUIT_BREAKER_BACKOFF_MS;
  });

  it("does not skip a healthy lane", async () => {
    const { apiCircuitBreakerShouldSkip } = await load();
    expect(apiCircuitBreakerShouldSkip("healthy-svc", "user").skip).toBe(false);
  });

  it("trips only the failing lane; keeps cooling down; leaves the sibling env lane open", async () => {
    const { apiCircuitBreakerShouldSkip } = await load();
    await seedFailures("fmp-trip", "user", 5);
    // First check trips it (default 60s cool-down).
    expect(apiCircuitBreakerShouldSkip("fmp-trip", "user").skip).toBe(true);
    // Still cooling down on the next call.
    expect(apiCircuitBreakerShouldSkip("fmp-trip", "user").skip).toBe(true);
    // The env lane of the same service was never failing → not skipped.
    expect(apiCircuitBreakerShouldSkip("fmp-trip", "env").skip).toBe(false);
  });

  it("allows a half-open probe once the cool-down elapses", async () => {
    const { apiCircuitBreakerShouldSkip } = await load();
    process.env.API_CIRCUIT_BREAKER_BACKOFF_MS = "0"; // cool-down elapses immediately
    await seedFailures("fmp-halfopen", "user", 5);
    expect(apiCircuitBreakerShouldSkip("fmp-halfopen", "user").skip).toBe(true); // trips (until = now + 0)
    // Cool-down already elapsed → one half-open probe is allowed through.
    expect(apiCircuitBreakerShouldSkip("fmp-halfopen", "user").skip).toBe(false);
  });

  it("is a no-op when API_CIRCUIT_BREAKER_DISABLED is set", async () => {
    const { apiCircuitBreakerShouldSkip } = await load();
    await seedFailures("fmp-disabled", "user", 5);
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    expect(apiCircuitBreakerShouldSkip("fmp-disabled", "user").skip).toBe(false);
  });
});

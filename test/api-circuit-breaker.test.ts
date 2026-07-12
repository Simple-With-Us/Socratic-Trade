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

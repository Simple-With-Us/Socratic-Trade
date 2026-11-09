/**
 * Soft/expected-limit health rows (429, daily caps) must not paint a lane red STOPPED
 * (consecutive-failures) or trip the transport circuit breaker. Hard 5xx still do.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-soft-health-${randomUUID()}.db`)}`;
});

async function load() {
  const health = await import("../src/lib/db-health");
  const breaker = await import("../src/lib/api-circuit-breaker");
  return { ...health, ...breaker };
}

describe("soft expected-limit health failures", () => {
  beforeEach(async () => {
    const { resetApiCircuitBreaker } = await load();
    resetApiCircuitBreaker();
    delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    delete process.env.API_CIRCUIT_BREAKER_BACKOFF_MS;
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log").run();
  });

  it("isSoftHealthFailure recognizes prefix and free-text 429/daily-cap shapes", async () => {
    const { isSoftHealthFailure, HEALTH_SOFT_FAILURE_PREFIX } = await load();
    expect(isSoftHealthFailure(`${HEALTH_SOFT_FAILURE_PREFIX}HTTP 429`)).toBe(true);
    expect(isSoftHealthFailure("HTTP 429 (rate limited, retrying)")).toBe(true);
    expect(isSoftHealthFailure("Alpha Vantage: entire key pool exhausted for today (1/1 keys hit the 25/day cap)")).toBe(true);
    expect(isSoftHealthFailure("Alpha Vantage: proactive daily call budget exhausted (self-limited to 23/day)")).toBe(true);
    expect(isSoftHealthFailure("HTTP 500")).toBe(false);
    expect(isSoftHealthFailure("fetch failed")).toBe(false);
  });

  it("five soft 429s do NOT hard-STOP the lane or trip the transport breaker", async () => {
    const { logApiHealth, getLaneHealth, getServiceHealthSummaries, apiCircuitBreakerShouldSkip, HEALTH_REASON_CONSECUTIVE_FAILURES } =
      await load();
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "vix-yahoo", ok: false, errorText: "HTTP 429", soft: true });
    }
    // keySource defaults to null in log when omitted
    const lane = getLaneHealth("vix-yahoo", null);
    // May be soft-yellow (no success this hour) but NOT hard consecutive-failures.
    if (lane.stoppedWorking) {
      expect(lane.reason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    }
    expect(apiCircuitBreakerShouldSkip("vix-yahoo", null).skip).toBe(false);

    const summary = getServiceHealthSummaries().find((s) => s.service === "vix-yahoo" && s.keySource == null);
    expect(summary).toBeDefined();
    if (summary?.stoppedWorking) {
      expect(summary.stoppedReasonKind).not.toBe("consecutive-failures");
    }
  });

  it("five hard HTTP 500s still hard-STOP and trip the breaker", async () => {
    const { logApiHealth, getLaneHealth, apiCircuitBreakerShouldSkip, HEALTH_REASON_CONSECUTIVE_FAILURES } = await load();
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "nasdaq-quote", ok: false, errorText: "HTTP 500" });
    }
    const lane = getLaneHealth("nasdaq-quote", null);
    expect(lane.stoppedWorking).toBe(true);
    expect(lane.reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(apiCircuitBreakerShouldSkip("nasdaq-quote", null).skip).toBe(true);
  });

  it("logApiHealth soft:true stamps the expected-limit prefix", async () => {
    const { logApiHealth, getServiceHealthLog, HEALTH_SOFT_FAILURE_PREFIX } = await load();
    logApiHealth({
      service: "alpha-vantage",
      ok: false,
      soft: true,
      errorText: "entire key pool exhausted for today (1/1 keys hit the 25/day cap)",
      keySource: "env",
    });
    const rows = getServiceHealthLog("alpha-vantage", 1, 0, "env");
    expect(rows[0]?.error_text?.startsWith(HEALTH_SOFT_FAILURE_PREFIX)).toBe(true);
  });

  it("mixed soft then hard does not trip until 5 hard in a row in the last-5 window", async () => {
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await load();
    // last-5 window (newest first when read): 3 hard + 2 soft = not all hard
    for (let i = 0; i < 2; i++) logApiHealth({ service: "mix-svc", ok: false, errorText: "HTTP 429", soft: true });
    for (let i = 0; i < 3; i++) logApiHealth({ service: "mix-svc", ok: false, errorText: "HTTP 500" });
    const lane = getLaneHealth("mix-svc", null);
    // last 5 are all failures but only 3 hard → no consecutive-failures
    if (lane.stoppedWorking) {
      expect(lane.reason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    }
  });
});

describe("Nasdaq UA uses browser string", () => {
  it("calendar + quote paths bind NASDAQ_*_UA to BROWSER_UA (not a bot UA constant)", async () => {
    // Source-level guarantee: both consumers import BROWSER_UA and assign it to the request UA.
    // Comments may still mention the old bot string as historical context — only assert the live binding.
    const fs = await import("node:fs");
    const cal = fs.readFileSync("src/lib/nasdaq-calendar-provider.ts", "utf8");
    expect(cal).toMatch(/const NASDAQ_CALENDAR_UA\s*=\s*BROWSER_UA/);
    const dp = fs.readFileSync("src/lib/data-providers.ts", "utf8");
    expect(dp).toMatch(/const NASDAQ_QUOTE_UA\s*=\s*BROWSER_UA/);
    // No live string-literal bot UA remaining (comments excluded by requiring the assignment form).
    expect(dp).not.toMatch(/const NASDAQ_QUOTE_UA\s*=\s*["']Mozilla\/5\.0 \(compatible; SocraticTrade/);
    expect(cal).not.toMatch(/const NASDAQ_CALENDAR_UA\s*=\s*["']Mozilla\/5\.0 \(compatible; SocraticTrade/);
  });
});

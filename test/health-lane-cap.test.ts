import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// api_health_log rows are kept forever (2026-10-15). HEALTH_LOG_LANE_CAP is only a read bound for
// streak heuristics. Window counts in ServiceHealthSummary are exact COUNTs over the full table.
// Isolated temp SQLite per file (the db singleton must not leak across files).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-cap-${randomUUID()}.db`)}`;
});

async function load() {
  return import("../src/lib/db-health");
}

describe("api_health_log forever retention", () => {
  it("keeps every row per lane and reports exact window counts", async () => {
    const { logApiHealth, getServiceHealthSummaries, HEALTH_LOG_LANE_CAP } = await load();
    const service = `cap-lane-${randomUUID().slice(0, 8)}`;
    const extra = 20;

    for (let i = 0; i < HEALTH_LOG_LANE_CAP + extra; i++) {
      logApiHealth({ service, ok: true, latencyMs: 5, keySource: "env" });
    }

    const { getDb } = await import("../src/lib/db");
    const retained = (
      getDb()
        .prepare("SELECT COUNT(*) as cnt FROM api_health_log WHERE service = ? AND key_source IS ?")
        .get(service, "env") as { cnt: number }
    ).cnt;
    expect(retained).toBe(HEALTH_LOG_LANE_CAP + extra);

    const summary = getServiceHealthSummaries().find((s) => s.service === service && s.keySource === "env");
    expect(summary).toBeDefined();
    expect(summary?.callsLast24h).toBe(HEALTH_LOG_LANE_CAP + extra);
    expect(summary?.callsLastHour).toBe(HEALTH_LOG_LANE_CAP + extra);
    expect(summary?.laneLogCap).toBeUndefined();
  });

  it("does not evict, or mark saturated, a lane below the cap", async () => {
    const { logApiHealth, getServiceHealthSummaries, HEALTH_LOG_LANE_CAP } = await load();
    const service = `small-lane-${randomUUID().slice(0, 8)}`;

    for (let i = 0; i < 7; i++) {
      logApiHealth({ service, ok: true, latencyMs: 5, keySource: "env" });
    }

    const summary = getServiceHealthSummaries().find((s) => s.service === service && s.keySource === "env");
    expect(summary?.callsLast24h).toBe(7);
    expect(summary?.callsLast24h).toBeLessThan(HEALTH_LOG_LANE_CAP);
  });

  it("counts each (service, key_source) lane independently without cross-lane deletes", async () => {
    const { logApiHealth, getServiceHealthSummaries, HEALTH_LOG_LANE_CAP } = await load();
    const service = `two-lane-${randomUUID().slice(0, 8)}`;
    const envRows = HEALTH_LOG_LANE_CAP + 5;

    for (let i = 0; i < envRows; i++) {
      logApiHealth({ service, ok: true, keySource: "env" });
    }
    logApiHealth({ service, ok: true, keySource: "user", userId: "local" });

    const summaries = getServiceHealthSummaries().filter((s) => s.service === service);
    expect(summaries.find((s) => s.keySource === "env")?.callsLast24h).toBe(envRows);
    expect(summaries.find((s) => s.keySource === "user")?.callsLast24h).toBe(1);
  });
});

describe("stoppedReasonKind — hard vs soft stop", () => {
  it("reports the hard kind after five consecutive failures", async () => {
    const { logApiHealth, getServiceHealthSummaries, HEALTH_REASON_CONSECUTIVE_FAILURES } = await load();
    const service = `hard-stop-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "HTTP 500", keySource: "env" });
    }

    const summary = getServiceHealthSummaries().find((s) => s.service === service);
    expect(summary?.stoppedWorking).toBe(true);
    expect(summary?.stoppedReason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(summary?.stoppedReasonKind).toBe("consecutive-failures");
  });

  it("reports a soft kind for a single cold failure, so it is not counted as a hard stop", async () => {
    const { logApiHealth, getServiceHealthSummaries, HEALTH_REASON_CONSECUTIVE_FAILURES } = await load();
    const service = `soft-stop-${randomUUID().slice(0, 8)}`;
    logApiHealth({ service, ok: false, errorText: "ECONNRESET", keySource: "env" });

    const summary = getServiceHealthSummaries().find((s) => s.service === service);
    // stoppedWorking is still true (unchanged behaviour) — only the KIND distinguishes it.
    expect(summary?.stoppedWorking).toBe(true);
    expect(summary?.stoppedReason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(summary?.stoppedReasonKind).toBe("no-success-ever");
  });

  it("leaves the kind null on a healthy lane", async () => {
    const { logApiHealth, getServiceHealthSummaries } = await load();
    const service = `healthy-${randomUUID().slice(0, 8)}`;
    logApiHealth({ service, ok: true, latencyMs: 12, keySource: "env" });

    const summary = getServiceHealthSummaries().find((s) => s.service === service);
    expect(summary?.stoppedWorking).toBe(false);
    expect(summary?.stoppedReasonKind).toBeNull();
  });
});

describe("admin connections panel count formatting", () => {
  it("renders a saturated count as N+ and any lower count exactly", async () => {
    const { formatLaneCallCount } = await import("../app/admin/connections/connections-health-client");

    expect(formatLaneCallCount(499, 500)).toBe("499");
    expect(formatLaneCallCount(500, 500)).toBe("500+");
    // Defensive: a count somehow above the cap is still reported as the honest floor, not "501".
    expect(formatLaneCallCount(501, 500)).toBe("500+");
    expect(formatLaneCallCount(0, 500)).toBe("0");
    // Placeholder lanes synthesized by the route carry no cap — never fabricate a "+".
    expect(formatLaneCallCount(0, undefined)).toBe("0");
    expect(formatLaneCallCount(1200, undefined)).toBe("1200");
  });

  it("maps earningscalls aliases to one EarningsCalls.dev label", async () => {
    const { formatServiceName } = await import("../app/admin/connections/connections-health-client");
    expect(formatServiceName("earningscalls-dev-rapidapi")).toBe("EarningsCalls.dev");
    expect(formatServiceName("earningscalls")).toBe("EarningsCalls.dev");
    expect(formatServiceName("earningscall")).toBe("EarningsCalls.dev");
  });
});

describe("getServiceHealthSummaries treats FilingAPI 401 as a soft skip", () => {
  it("filingapi 401s are not intentionalOff and do not hard-STOP", async () => {
    const { logApiHealth, getServiceHealthSummaries, HEALTH_REASON_CONSECUTIVE_FAILURES } = await load();
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "filingapi", ok: false, errorText: "HTTP 401 Unauthorized", keySource: "env" });
    }
    const summary = getServiceHealthSummaries().find((s) => s.service === "filingapi" && s.keySource === "env");
    expect(summary).toBeDefined();
    expect(summary?.intentionalOff).toBeFalsy();
    expect(summary?.stoppedReasonKind).not.toBe("consecutive-failures");
    expect(summary?.stoppedReason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
  });
});

describe("admin connections intentional OFF (retired FMP/Quiver)", () => {
  it("treats intentionalOff as muted OFF — never hard-stopped / soft-degraded", async () => {
    const {
      isHardStopped,
      isSoftDegraded,
      statusTone,
      laneSortRank
    } = await import("../app/admin/connections/connections-health-client");

    const retiredFmp = {
      service: "fmp",
      keySource: "env" as string | null,
      lastSuccessTs: null,
      lastSuccessLatencyMs: null,
      lastFailureTs: "2026-08-05T00:00:00.000Z",
      lastFailureError: "403",
      callsLastHour: 5,
      callsLast24h: 5,
      stoppedWorking: true,
      stoppedReason: "Last 5 consecutive calls failed",
      stoppedReasonKind: "consecutive-failures" as const,
      intentionalOff: true
    };

    expect(isHardStopped(retiredFmp)).toBe(false);
    expect(isSoftDegraded(retiredFmp)).toBe(false);
    expect(statusTone(retiredFmp)).toBe("muted");
    expect(laneSortRank(retiredFmp)).toBe(3);

    const hard = { ...retiredFmp, intentionalOff: false };
    expect(isHardStopped(hard)).toBe(true);
    expect(statusTone(hard)).toBe("neg");
    expect(laneSortRank(hard)).toBe(0);
  });
});

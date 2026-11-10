import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetFilingApiAuthStateForTests } from "../src/lib/filingapi-auth";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resetDbForTesting } from "../src/lib/db";
import {
  isLaneDueForReprobe,
  parseKnownUnavailabilityUntil,
  openHardStopReprobeWindow,
  healthReprobeLaneSettingKey,
  usageMonitorProbeUrls,
  probeFnForService,
  backupLanePrimaryIsServing,
} from "../src/lib/health-lane-reprobe";
import {
  logApiHealth,
  getServiceHealthSummaries,
  HEALTH_REASON_CONSECUTIVE_FAILURES,
} from "../src/lib/db-health";

describe("health-lane-reprobe", () => {
  let dir: string;
  let prevDb: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `health-reprobe-${randomUUID()}-`));
    prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
    process.env.HEALTH_LANE_REPROBE_ENABLED = "on";
    resetFilingApiAuthStateForTests();
    resetDbForTesting();
  });

  afterEach(() => {
    resetDbForTesting();
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("does not treat Yahoo VIX as a probe target while Cboe history is serving", () => {
    expect(
      backupLanePrimaryIsServing("vix-yahoo", [
        { service: "vix-cboe-history", keySource: null, stoppedWorking: false },
        { service: "vix-yahoo", keySource: null, stoppedWorking: true }
      ])
    ).toBe(true);
    expect(
      backupLanePrimaryIsServing("vix-yahoo", [
        { service: "vix-cboe-history", keySource: null, stoppedWorking: true },
        { service: "vix-yahoo", keySource: null, stoppedWorking: true }
      ])
    ).toBe(false);
  });

  it("parseKnownUnavailabilityUntil honors Retry-After and AV daily language", () => {
    const now = Date.parse("2026-08-06T15:00:00.000Z");
    const ra = parseKnownUnavailabilityUntil("HTTP 429 Retry-After: 120", now);
    expect(ra).toBe(now + 120_000);

    const daily = parseKnownUnavailabilityUntil("Note daily API call limit 25/day", now);
    expect(daily).toBeGreaterThan(now);
    expect(daily! - now).toBeLessThanOrEqual(48 * 3600_000);

    expect(parseKnownUnavailabilityUntil("random boom", now)).toBeNull();
  });

  it("isLaneDueForReprobe waits for interval after last failure", () => {
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    const lastFail = new Date(now - 1 * 3600_000).toISOString(); // 1h ago
    const notDue = isLaneDueForReprobe(
      { lastFailureTs: lastFail, lastFailureError: "HTTP 500", stoppedReason: HEALTH_REASON_CONSECUTIVE_FAILURES },
      now,
      { intervalMs: 4 * 3600_000 }
    );
    expect(notDue.due).toBe(false);
    expect(notDue.reason).toBe("interval_not_elapsed");

    const due = isLaneDueForReprobe(
      {
        lastFailureTs: new Date(now - 5 * 3600_000).toISOString(),
        lastFailureError: "HTTP 500",
        stoppedReason: HEALTH_REASON_CONSECUTIVE_FAILURES
      },
      now,
      { intervalMs: 4 * 3600_000 }
    );
    expect(due.due).toBe(true);
  });

  it("openHardStopReprobeWindow softens hard failures so consecutive stop lifts", () => {
    for (let i = 0; i < 5; i++) {
      logApiHealth({
        service: "nasdaq-quote",
        ok: false,
        errorText: `HTTP 500 boom-${i}`,
        keySource: undefined
      });
    }
    const before = getServiceHealthSummaries().find((s) => s.service === "nasdaq-quote");
    expect(before?.stoppedWorking).toBe(true);
    expect(before?.stoppedReason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);

    const n = openHardStopReprobeWindow("nasdaq-quote", null);
    expect(n).toBe(5);

    const after = getServiceHealthSummaries().find((s) => s.service === "nasdaq-quote");
    // Soft failures no longer count as hard consecutive stop
    expect(after?.stoppedReason === HEALTH_REASON_CONSECUTIVE_FAILURES).toBe(false);
  });

  it("isLaneDueForReprobe waits for known quota until", () => {
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    const until = new Date(now + 6 * 3600_000).toISOString();
    const r = isLaneDueForReprobe(
      {
        lastFailureTs: new Date(now - 10 * 3600_000).toISOString(),
        lastFailureError: `daily budget exhausted until=${until}`,
        stoppedReason: HEALTH_REASON_CONSECUTIVE_FAILURES
      },
      now,
      { intervalMs: 4 * 3600_000 }
    );
    expect(r.due).toBe(false);
    expect(r.reason).toBe("waiting_quota_or_known_until");
    expect(healthReprobeLaneSettingKey("alpha-vantage", "env")).toContain("alpha-vantage");
  });

  it("probes Usage Monitor at /api/ready then /api/health, never /health or /", () => {
    expect(usageMonitorProbeUrls("https://usage.jays.services")).toEqual([
      "https://usage.jays.services/api/ready",
      "https://usage.jays.services/api/health",
    ]);
    const prev = process.env.USAGE_MONITOR_BASE_URL;
    process.env.USAGE_MONITOR_BASE_URL = "https://usage.example.test/";
    try {
      expect(usageMonitorProbeUrls()).toEqual([
        "https://usage.example.test/api/ready",
        "https://usage.example.test/api/health",
      ]);
    } finally {
      if (prev === undefined) delete process.env.USAGE_MONITOR_BASE_URL;
      else process.env.USAGE_MONITOR_BASE_URL = prev;
    }
  });

  it("usage-monitor probe succeeds on /api/ready 200 and ignores a login 307", async () => {
    const seen: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/api/ready")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(null, { status: 307, headers: { Location: "/login" } });
    }) as typeof fetch;
    try {
      const probe = probeFnForService("usage-monitor");
      expect(probe).not.toBeNull();
      const result = await probe!();
      expect(result.ok).toBe(true);
      expect(seen[0]).toMatch(/\/api\/ready$/);
      expect(seen.some((u) => u.endsWith("/health") || /usage\.jays\.services\/$/.test(u))).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it("filingapi probe skips with ok when no key is set", async () => {
    const prev = process.env.FILINGAPI;
    const prevKey = process.env.FILINGAPI_KEY;
    const prevAlt = process.env.FILING_API_KEY;
    delete process.env.FILINGAPI;
    delete process.env.FILINGAPI_KEY;
    delete process.env.FILING_API_KEY;
    resetFilingApiAuthStateForTests();
    const seen: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      const probe = probeFnForService("filingapi");
      expect(probe).not.toBeNull();
      const result = await probe!();
      expect(result.ok).toBe(true);
      expect(result.detail).toBe("no-key-skip");
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = prevFetch;
      if (prev === undefined) delete process.env.FILINGAPI;
      else process.env.FILINGAPI = prev;
      if (prevKey === undefined) delete process.env.FILINGAPI_KEY;
      else process.env.FILINGAPI_KEY = prevKey;
      if (prevAlt === undefined) delete process.env.FILING_API_KEY;
      else process.env.FILING_API_KEY = prevAlt;
    }
  });

  it("filingapi probe treats a live 401 as ok skip and does not call again", async () => {
    const prev = process.env.FILINGAPI;
    process.env.FILINGAPI = "dead-trial-key";
    resetFilingApiAuthStateForTests();
    let hits = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      hits += 1;
      expect(String(input)).toContain("filingapi.dev");
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;
    try {
      const probe = probeFnForService("filingapi")!;
      const first = await probe();
      expect(first.ok).toBe(true);
      expect(first.detail).toMatch(/401/);
      expect(hits).toBe(1);
      const second = await probe();
      expect(second.ok).toBe(true);
      expect(second.detail).toBe("unauthorized-skip");
      expect(hits).toBe(1);
    } finally {
      globalThis.fetch = prevFetch;
      resetFilingApiAuthStateForTests();
      if (prev === undefined) delete process.env.FILINGAPI;
      else process.env.FILINGAPI = prev;
    }
  });
});

// Connection-health alerting must fire on OUTAGES and stay silent on BLIPS.
//
// Prod symptom (2026-08-12): ~28 distinct Sentry issues titled "<name> connection failed", almost
// none of which corresponded to a real outage. Four independent causes, all pinned here:
//
//   1. The alert gate keyed off `lane.stoppedWorking`, which is ALSO set by two soft heuristics
//      ("active this hour but no successful call ever" / "…no success in 60 min"). On a
//      low-frequency lane the FIRST transient failure satisfies one of those instantly — one call
//      this hour, zero successes — so a single blip paged with no streak at all.
//   2. Sentry fingerprinted these by message text, and the message embeds a DISPLAY name that
//      drifts, so one lane fragmented into several issues.
//   5. Product-retired vendors (FMP / Quiver / Unusual Whales) still paged from residual call
//      sites even though Admin Connections deliberately renders them as muted OFF.
//   4. The hard-stop re-probe logged its own SYNTHETIC probe failures hard, which re-satisfied the
//      gate, which re-armed the 6h cooldown, which kept the lane in the probe candidate set —
//      a loop that alerted forever about a lane no product code was calling.
//
// The discriminating half of this suite is the NEGATIVE side: a genuine outage (repeated hard
// 5xx) must still page. FilingAPI 401 is an optional-key skip, not an outage — it must not page.
// Those cases are asserted explicitly below, because a "fix" that silences the noise by silencing
// everything would be strictly worse than the bug.
//
// Hermetic: real module graph against a temp SQLite DB; only the Sentry SDK and `fetch` are stubbed.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  withScope: vi.fn(),
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
  setFingerprint: vi.fn()
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  withScope: sentry.withScope
}));

// ONE database for the whole file. `logApiHealth` fires its alert as a DETACHED promise, so
// closing/reopening the connection between cases would race that promise into
// "The database connection is not open" instead of exercising the gate. Tables are truncated
// between cases instead.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-alert-gate-${randomUUID()}.db`)}`;
});

async function db() {
  return import("../src/lib/db");
}

/** Every `connection_health_alert` audit row — one is written per alert that actually fired. */
async function alertKinds(): Promise<string[]> {
  const { getDb } = await db();
  const rows = getDb()
    .prepare(`SELECT payload FROM audit_events WHERE kind = 'connection_health_alert' ORDER BY rowid`)
    .all() as Array<{ payload: string }>;
  return rows.map((r) => String(JSON.parse(r.payload).service));
}

/** Newest api_health_log error text for a lane (soft rows carry the expected-limit prefix). */
async function newestErrorText(service: string): Promise<string | null> {
  const { getDb } = await db();
  const row = getDb()
    .prepare(`SELECT error_text FROM api_health_log WHERE service = ? ORDER BY ts DESC, rowid DESC LIMIT 1`)
    .get(service) as { error_text: string | null } | undefined;
  return row?.error_text ?? null;
}

/**
 * logApiHealth fires the alert as a detached promise whose first step is a dynamic `import`.
 * Give it real time to land so a NEGATIVE assertion ("did not alert") is meaningful rather than
 * merely early. Positive assertions use `vi.waitFor` instead, so they never depend on this budget.
 */
async function settleAlerts(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  vi.clearAllMocks();
  sentry.withScope.mockImplementation((cb: (scope: unknown) => void) =>
    cb({
      setLevel: sentry.setLevel,
      setTag: sentry.setTag,
      setContext: sentry.setContext,
      setFingerprint: sentry.setFingerprint
    })
  );
  process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
  delete process.env.RESEND_API_KEY;
  delete process.env.PUSHOVER_TOKEN;
  const { getDb } = await db();
  for (const table of ["api_health_log", "api_health_error_patterns", "audit_events", "settings", "notification_events"]) {
    getDb().prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(async () => {
  // Let any still-detached alert from this case finish against a live connection before the next
  // case truncates, so it cannot bleed an audit row across the boundary.
  await settleAlerts();
  delete process.env.SENTRY_DSN;
  delete process.env.HEALTH_LANE_REPROBE_ENABLED;
  delete process.env.HEALTH_LANE_REPROBE_INTERVAL_HOURS;
  delete process.env.DB_BOOTSTRAP;
  delete process.env.HEALTH_ALERT_STARTUP_GRACE_SECONDS;
  vi.unstubAllGlobals();
});

describe("connection-health startup grace (live Coolify only)", () => {
  it("never suppresses outside DB_BOOTSTRAP=live", async () => {
    const { shouldSuppressConnectionAlertForStartup } = await import("../src/lib/db-health");
    expect(shouldSuppressConnectionAlertForStartup(0, {})).toBe(false);
    expect(shouldSuppressConnectionAlertForStartup(0, { DB_BOOTSTRAP: "fresh" })).toBe(false);
    expect(shouldSuppressConnectionAlertForStartup(10, { DB_BOOTSTRAP: "live" })).toBe(true);
    expect(shouldSuppressConnectionAlertForStartup(400, { DB_BOOTSTRAP: "live" })).toBe(false);
    expect(shouldSuppressConnectionAlertForStartup(10, { DB_BOOTSTRAP: "live", HEALTH_ALERT_STARTUP_GRACE_SECONDS: "0" })).toBe(false);
  });
});

describe("connection-health alert gate: hard streak required", () => {
  it("five caller-budget aborts stay silent (soft, not an outage)", async () => {
    const { logApiHealth, getLaneHealth, isSoftHealthFailure } = await import("../src/lib/db-health");
    expect(isSoftHealthFailure("This operation was aborted")).toBe(true);
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "nasdaq-calendar", ok: false, errorText: "This operation was aborted" });
    }
    await settleAlerts();
    expect(getLaneHealth("nasdaq-calendar", null).reason).not.toBe("Last 5 consecutive calls all failed");
    expect(await alertKinds()).toEqual([]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("one transient failure on a cold low-frequency lane does NOT alert", async () => {
    const { logApiHealth, getLaneHealth } = await import("../src/lib/db-health");

    logApiHealth({ service: "vix-cboe", ok: false, errorText: "fetch failed" });
    await settleAlerts();

    // The lane legitimately reads as stopped — the SOFT "no success ever" heuristic is true with a
    // single failing call this hour. That is exactly the state that used to page, and the whole
    // point of the fix is that this state alone is not evidence of an outage.
    const lane = getLaneHealth("vix-cboe", null);
    expect(lane.stoppedWorking).toBe(true);
    expect(lane.reason).toBe("Active in past hour but no successful call ever");

    expect(await alertKinds()).toEqual([]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("four hard failures stay silent; the fifth (hard streak) alerts once", async () => {
    const { logApiHealth, HEALTH_REASON_CONSECUTIVE_FAILURES, getLaneHealth } = await import(
      "../src/lib/db-health"
    );

    for (let i = 0; i < 4; i++) {
      logApiHealth({ service: "nasdaq-quote", ok: false, errorText: `HTTP 500 boom-${i}` });
    }
    await settleAlerts();
    expect(await alertKinds()).toEqual([]);

    logApiHealth({ service: "nasdaq-quote", ok: false, errorText: "HTTP 500 boom-4" });
    expect(getLaneHealth("nasdaq-quote", null).reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    await vi.waitFor(async () => expect(await alertKinds()).toEqual(["nasdaq-quote"]));

    // Sixth failure inside the 6h cooldown must not mint a second alert.
    logApiHealth({ service: "nasdaq-quote", ok: false, errorText: "HTTP 500 boom-5" });
    await settleAlerts();
    expect(await alertKinds()).toEqual(["nasdaq-quote"]);
  });

  it("REGRESSION GUARD: a real congress.trade 502 outage still alerts", async () => {
    // SOCRATIC-TRADE-B / -8 / -1P. A genuine upstream outage produces a run of hard 5xx within
    // minutes, so the streak gate is satisfied and the operator is still paged.
    const { logApiHealth } = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "congress-trade", ok: false, errorText: "HTTP 502 Bad Gateway", keySource: "env" });
    }
    await vi.waitFor(async () => expect(await alertKinds()).toEqual(["congress-trade"]));
  });

  it("filingapi 401 is a soft skip and does not alert", async () => {
    // Optional lane: a dead trial key must not page. ROIC + EDGAR cover the fields.
    const { logApiHealth } = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "filingapi", ok: false, errorText: "HTTP 401 Unauthorized", keySource: "env" });
    }
    await settleAlerts();
    expect(await alertKinds()).toEqual([]);
  });

  it("live boot window does not page a hard streak", async () => {
    process.env.DB_BOOTSTRAP = "live";
    process.env.HEALTH_ALERT_STARTUP_GRACE_SECONDS = "3600";
    const { logApiHealth, shouldSuppressConnectionAlertForStartup } = await import("../src/lib/db-health");
    expect(shouldSuppressConnectionAlertForStartup(10, process.env)).toBe(true);
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "nasdaq-quote", ok: false, errorText: `HTTP 500 boot-${i}` });
    }
    await settleAlerts();
    expect(await alertKinds()).toEqual([]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("live after the boot grace still pages a hard streak", async () => {
    process.env.DB_BOOTSTRAP = "live";
    process.env.HEALTH_ALERT_STARTUP_GRACE_SECONDS = "0";
    const { logApiHealth, shouldSuppressConnectionAlertForStartup } = await import("../src/lib/db-health");
    expect(shouldSuppressConnectionAlertForStartup(10, process.env)).toBe(false);
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "congress-trade", ok: false, errorText: `HTTP 502 after-boot-${i}`, keySource: "env" });
    }
    await vi.waitFor(async () => expect(await alertKinds()).toEqual(["congress-trade"]));
  });

  it("quotaResetAt still alerts on the very first row (single 'pool exhausted' signal)", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    logApiHealth({
      service: "alpha-vantage",
      ok: false,
      soft: true,
      errorText: "entire key pool exhausted for today (1/1 keys hit the 25/day cap)",
      keySource: "env",
      quotaResetAt: new Date(Date.now() + 8 * 3600_000).toISOString()
    });
    await vi.waitFor(async () => expect(await alertKinds()).toEqual(["alpha-vantage"]));
  });
});

describe("connection-health alert gate: retired vendors", () => {
  it("a product-retired vendor lane never alerts, even at a full hard streak", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    for (const service of ["fmp", "fmp-transcripts", "quiverquant", "unusual_whales"]) {
      for (let i = 0; i < 5; i++) {
        logApiHealth({ service, ok: false, errorText: "HTTP 403 Forbidden", keySource: "env" });
      }
    }
    await settleAlerts();
    expect(await alertKinds()).toEqual([]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe("connection-health Sentry grouping", () => {
  it("fingerprints by the stable service id, not the display-name-derived message", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "congress-trade", ok: false, errorText: `HTTP 502 attempt-${i}`, keySource: "env" });
    }
    await vi.waitFor(() =>
      expect(sentry.captureMessage).toHaveBeenCalledWith("congress-trade connection failed")
    );
    expect(sentry.setFingerprint).toHaveBeenCalledWith(["api-health", "congress-trade"]);
  });
});

describe("hard-stop re-probe failures are synthetic, not evidence", () => {
  it("logs a failed probe SOFT so it cannot page or re-arm the alert cooldown", async () => {
    process.env.HEALTH_LANE_REPROBE_ENABLED = "on";
    const { logApiHealth, HEALTH_SOFT_FAILURE_PREFIX } = await import("../src/lib/db-health");

    // Seed a genuinely hard-stopped usage-monitor lane (this one has a live probe fn).
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "usage-monitor", ok: false, errorText: `HTTP 500 seed-${i}` });
    }
    await vi.waitFor(async () => expect(await alertKinds()).toEqual(["usage-monitor"]));

    // The probe itself fails with a plain hard 5xx — the shape the old regex did NOT treat as soft.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );

    const { runHealthLaneReprobeIfDue } = await import("../src/lib/health-lane-reprobe");
    // Run "in the future" so the re-probe interval has elapsed for this lane.
    const result = await runHealthLaneReprobeIfDue(Date.now() + 12 * 3600_000, { force: true });
    expect(result.results.some((r) => r.service === "usage-monitor" && r.outcome === "probe_fail")).toBe(true);

    const newest = await newestErrorText("usage-monitor");
    expect(newest).toContain(HEALTH_SOFT_FAILURE_PREFIX);
    expect(newest).toContain("HTTP 500");

    // Still exactly the one seeded alert: the synthetic probe added no new page.
    await settleAlerts();
    expect(await alertKinds()).toEqual(["usage-monitor"]);
  });
});

describe("usage-monitor reads are fail-open, so their failures are soft", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_BASE_URL = "https://usage.example.test";
    process.env.USAGE_INGEST_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("budget-status records ok=0 SOFT on a network failure and never pages", async () => {
    const failing = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const { getBudgetStatusCached } = await import("../src/lib/usage-budget");
    expect(await getBudgetStatusCached({ force: true, fetchImpl: failing })).toBeNull();

    const { HEALTH_SOFT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    expect(await newestErrorText("usage-monitor")).toContain(HEALTH_SOFT_FAILURE_PREFIX);

    await settleAlerts();
    expect(await alertKinds()).toEqual([]);
  });

  it("knobs records ok=0 SOFT on a network failure and never pages", async () => {
    const failing = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const knobs = await import("../src/lib/usage-monitor-knobs");
    knobs.resetUsageMonitorKnobsCacheForTests();
    knobs.getUsageMonitorKnobsCached({ fetchImpl: failing });
    await settleAlerts();

    const { HEALTH_SOFT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    expect(await newestErrorText("usage-monitor")).toContain(HEALTH_SOFT_FAILURE_PREFIX);
    expect(await alertKinds()).toEqual([]);
  });

  it("budget-status waits 8s, not 2.5s, before aborting a slow monitor", async () => {
    // The old 2500 ceiling aborted healthy-but-slow cross-internet responses often enough to be a
    // standing source of "usage-monitor connection failed". 8000 matches what the health-lane
    // re-probe already allows against this same host.
    vi.useFakeTimers();
    try {
      let aborted = false;
      const slow = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("The operation was aborted."));
          });
        })) as unknown as typeof fetch;

      const { getBudgetStatusCached } = await import("../src/lib/usage-budget");
      const pending = getBudgetStatusCached({ force: true, fetchImpl: slow });

      await vi.advanceTimersByTimeAsync(2_600);
      expect(aborted).toBe(false); // would already have aborted at the old 2500 default

      await vi.advanceTimersByTimeAsync(5_600);
      expect(aborted).toBe(true);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

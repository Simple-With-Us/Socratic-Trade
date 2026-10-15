// ST-3988 / PD #313: upstream D1/SQLite contention on Congress.Trade must not page as
// "congress-share connection failed" at Sentry error level.

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

const CONGRESS_D1_ERROR =
  'App A reported ok=false with 19 error(s); first: "WMT price: D1 batch error: SQLITE_BUSY: database is locked"';

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-db-contention-health-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.DB_BOOTSTRAP = "fresh";
});

beforeEach(() => {
  process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
  sentry.captureMessage.mockClear();
  sentry.withScope.mockClear();
  sentry.setLevel.mockClear();
  sentry.setTag.mockClear();
  sentry.setContext.mockClear();
  sentry.setFingerprint.mockClear();
  sentry.withScope.mockImplementation((cb: (scope: unknown) => void) => {
    cb({
      setLevel: sentry.setLevel,
      setTag: sentry.setTag,
      setContext: sentry.setContext,
      setFingerprint: sentry.setFingerprint
    });
    return undefined;
  });
});

afterEach(async () => {
  delete process.env.SENTRY_DSN;
  const { getDb } = await import("../src/lib/db");
  getDb().prepare("DELETE FROM api_health_log").run();
  getDb().prepare("DELETE FROM audit_events").run();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'healthAlertSent:%'").run();
});

describe("dependency DB contention classification", () => {
  it("detects Congress.Trade D1 busy errors embedded in congress-share import bodies", async () => {
    const { isDependencyDbContentionMessage } = await import("../src/lib/local-db-fault");
    expect(isDependencyDbContentionMessage(CONGRESS_D1_ERROR)).toBe(true);
    expect(isDependencyDbContentionMessage("HTTP 500 upstream unavailable")).toBe(false);
  });

  it("stamps db-contention prefix on health log rows and excludes them from the hard streak", async () => {
    const { logApiHealth, flushApiHealthBuffer, HEALTH_DB_CONTENTION_PREFIX, getLaneHealth } =
      await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "congress-share", ok: false, errorText: CONGRESS_D1_ERROR, keySource: "env" });
    }
    flushApiHealthBuffer();
    const { getDb } = await import("../src/lib/db");
    const row = getDb()
      .prepare(`SELECT error_text FROM api_health_log WHERE service = 'congress-share' ORDER BY ts DESC LIMIT 1`)
      .get() as { error_text: string };
    expect(row.error_text.startsWith(HEALTH_DB_CONTENTION_PREFIX)).toBe(true);
    const lane = getLaneHealth("congress-share", "env");
    expect(lane.reason).not.toBe("Last 5 consecutive calls all failed");
  });

  it("records warning-level degraded: db contention in Sentry, not connection failed", async () => {
    const health = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      health.logApiHealth({ service: "congress-share", ok: false, errorText: CONGRESS_D1_ERROR, keySource: "env" });
    }
    health.flushApiHealthBuffer();
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled());
    expect(sentry.setLevel).toHaveBeenCalledWith("warning");
    expect(sentry.captureMessage).toHaveBeenCalledWith("degraded: db contention");
    expect(capturedTag("health.failure_class")).toBe("db-contention");
    expect(sentry.captureMessage).not.toHaveBeenCalledWith("congress-share connection failed");
  });

  it("still pages a real congress-share transport failure at error level", async () => {
    const health = await import("../src/lib/db-health");
    const hardError = "HTTP 503 Service Unavailable — congress.trade import gateway down";
    for (let i = 0; i < 5; i++) {
      health.logApiHealth({ service: "congress-share", ok: false, errorText: hardError, keySource: "env" });
    }
    health.flushApiHealthBuffer();
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled());
    expect(sentry.setLevel).toHaveBeenCalledWith("error");
    expect(sentry.captureMessage).toHaveBeenCalledWith("congress-share connection failed");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });
});

function capturedTag(name: string): string | undefined {
  const hit = sentry.setTag.mock.calls.find((c) => c[0] === name);
  return hit ? String(hit[1]) : undefined;
}

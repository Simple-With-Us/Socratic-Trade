import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: { setLevel: (l: string) => void; setTag: (k: string, v: string) => void; setFingerprint: (f: string[]) => void; setContext: () => void }) => void) => {
    const tags: Record<string, string> = {};
    cb({
      setLevel: () => {},
      setTag: (k, v) => {
        tags[k] = v;
      },
      setFingerprint: () => {},
      setContext: () => {}
    });
    (sentry as { lastTags?: Record<string, string> }).lastTags = tags;
  })
}));

vi.mock("@sentry/nextjs", () => sentry);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `congress-dep-db-health-${randomUUID()}.db`)}`;
  process.env.SENTRY_DSN = "https://example.invalid/123";
});

async function resetDb(): Promise<void> {
  const { getDb, applyVersionedMigrations, deleteInternalSetting } = await import("../src/lib/db");
  const db = getDb();
  applyVersionedMigrations(db);
  db.prepare("DELETE FROM settings").run();
  db.prepare("DELETE FROM api_health_log").run();
  db.prepare("DELETE FROM audit_events").run();
  const { DEPENDENCY_DB_CONTENTION_WINDOW_KEY, DEPENDENCY_DB_CONTENTION_AUDIT_HOUR_KEY } = await import(
    "../src/lib/local-db-fault"
  );
  deleteInternalSetting(DEPENDENCY_DB_CONTENTION_WINDOW_KEY);
  deleteInternalSetting(DEPENDENCY_DB_CONTENTION_AUDIT_HOUR_KEY);
}

describe("congress-share dependency DB contention (ST-3988)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(process, "uptime").mockReturnValue(600);
    await resetDb();
  });

  const congressD1Error =
    'App A reported ok=false with 19 error(s); first: "WMT price: D1 batch error: SQLITE_BUSY: database is locked"';

  it("does not push provider_degraded for D1 contention and classifies Sentry as dependency-db-contention", async () => {
    const health = await import("../src/lib/db-health");
    const notificationsMod = await import("../src/lib/notifications");
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as never);

    await health.alertConnectionFailure("congress-share", "env", "local", congressD1Error);

    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledWith("congress-share dependency database contention");
    expect((sentry as { lastTags?: Record<string, string> }).lastTags?.["health.failure_class"]).toBe(
      "dependency-db-contention"
    );
    const kinds = (await import("../src/lib/db"))
      .getDb()
      .prepare("SELECT kind FROM audit_events")
      .all() as Array<{ kind: string }>;
    expect(kinds.map((r) => r.kind)).toContain("dependency_db_contention");
  });

  it("logApiHealth streak still alerts with dependency title, not connection failed", async () => {
    const { logApiHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await import("../src/lib/db-health");
    const notificationsMod = await import("../src/lib/notifications");
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as never);

    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "congress-share", ok: false, errorText: congressD1Error, keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });

    expect(sendNotificationSpy).not.toHaveBeenCalled();
    expect(sentry.captureMessage).toHaveBeenCalledWith("congress-share dependency database contention");
    const { getLaneHealth } = await import("../src/lib/db-health");
    expect(getLaneHealth("congress-share", "env").reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
  });

  it("connectionHealthFailureClass distinguishes D1 contention from HTTP 401", async () => {
    const { connectionHealthFailureClass } = await import("../src/lib/db-health");
    expect(connectionHealthFailureClass(congressD1Error)).toBe("dependency-db-contention");
    expect(connectionHealthFailureClass("HTTP 401 Unauthorized")).toBeNull();
  });

  it("does not treat non-contention D1 batch errors as dependency-db-contention", async () => {
    const { isDependencyDbContentionMessage } = await import("../src/lib/local-db-fault");
    const schemaFailure =
      'App A reported ok=false with 1 error(s); first: "WMT price: D1 batch error: UNIQUE constraint failed"';
    expect(isDependencyDbContentionMessage(schemaFailure)).toBe(false);
    expect(isDependencyDbContentionMessage('D1 batch error: table missing: congress_trades')).toBe(false);
  });
});

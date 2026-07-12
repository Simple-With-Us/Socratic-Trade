import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Use an isolated temp SQLite database per test file
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `connection-health-routing-${randomUUID()}.db`)}`;
});

async function load() {
  const db = await import("../src/lib/db");
  const health = await import("../src/lib/db-health");
  const notifyMod = await import("../src/lib/notify");
  const notificationsMod = await import("../src/lib/notifications");
  const healthRoute = await import("../app/api/health/route");
  return { db, health, notifyMod, notificationsMod, healthRoute };
}

describe("Connection Health & Failure Routing", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Stub environment variables for Resend/Notifications
    process.env.PRIMARY_USER_EMAIL = "admin@socratic.trade";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NOTIFY_EMAIL_FROM = "alerts@socratic.trade";
    
    // Clear out cooldown keys from DB
    const { db } = await load();
    db.getDb().prepare("DELETE FROM settings").run();
    db.getDb().prepare("DELETE FROM api_health_log").run();
  });

  afterEach(() => {
    delete process.env.PRIMARY_USER_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFY_EMAIL_FROM;
  });

  it("routes a global connection failure to admin email fallback & Sentry", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    // Mock notify & sendNotification
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call global failure alert (keySource: "env")
    await health.alertConnectionFailure("pinecone", "env", "u_tenant", "API Key Invalid");

    // notify() is ALWAYS called with the operator's own configured prefs (so local direct channels
    // like push/SMS fire even with no Resend fallback), and — because the default prefs carry no email
    // channel here — the operator fallback email is forced as an EXTRA notify call.
    expect(notifySpy).toHaveBeenCalled();
    // Every global notify routes to "local" with the right title/body.
    for (const call of notifySpy.mock.calls) {
      expect(call[0]).toBe("local");
      expect(call[1].title).toContain("pinecone connection failed");
      expect(call[1].body).toContain("API Key Invalid");
    }
    // At least one call must carry the forced fallback email as an extra channel.
    const forcedEmailCall = notifySpy.mock.calls.find((call) => call[2]?.prefs?.email === "admin@socratic.trade");
    expect(forcedEmailCall).toBeDefined();

    // Expect sendNotification was called for the global alert
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "local"
      })
    );
  });

  it("routes a user connection failure to user notifications only (no fallback email)", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call user failure alert (keySource: "user")
    await health.alertConnectionFailure("pinecone", "user", "u_tenant", "User Key Expired");

    // notify should only be called for the user's settings, not the admin fallback
    expect(notifySpy).toHaveBeenCalled();
    const notifyArgs = notifySpy.mock.calls[0];
    expect(notifyArgs[0]).toBe("u_tenant");
    // Ensure forcedPrefs was NOT injected with admin email
    expect(notifyArgs[2]?.prefs).toBeUndefined();

    // sendNotification should target the user
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "u_tenant"
      })
    );
  });

  it("/api/health returns 200 when dependencies are healthy", async () => {
    const { healthRoute, db } = await load();
    
    // Seed some successful health logs
    db.logApiHealth({ service: "pinecone", ok: true, keySource: "env" });
    db.logApiHealth({ service: "voyage", ok: true, keySource: "env" });

    // Seed lastTick so scheduler is not stale
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    const response = await healthRoute.GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies.pinecone.ok).toBe(true);
    expect(body.checks.dependencies.voyage.ok).toBe(true);
  });

  it("/api/health returns 503 when a critical global dependency fails, but stays 200 for user failures", async () => {
    const { healthRoute, db } = await load();

    // Seed lastTick
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // 1. Seed user failures (should not fail the global health check)
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Bad Key", keySource: "user", userId: "u_tenant" });
    }

    let response = await healthRoute.GET();
    expect(response.status).toBe(200); // Stays 200!
    let body = await response.json();
    expect(body.ok).toBe(true);

    // 2. Seed global/env failures for critical Pinecone (should fail the health check)
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Global Error", keySource: "env" });
    }

    response = await healthRoute.GET();
    expect(response.status).toBe(503); // Fails!
    body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.dependencies.pinecone.ok).toBe(false);
  });

  it("/api/health remains 200 but lists degraded status for non-critical global dependencies", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // Seed global failures for non-critical "apify"
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "apify", ok: false, errorText: "Global Error", keySource: "env" });
    }

    const response = await healthRoute.GET();
    expect(response.status).toBe(200); // Stays 200 because apify is not critical

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies.apify.ok).toBe(false);
  });
});

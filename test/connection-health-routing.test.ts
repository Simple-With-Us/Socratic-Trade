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
    db.getDb().prepare("DELETE FROM notification_prefs").run();
    db.getDb().prepare("DELETE FROM notification_events").run();
    db.getDb().prepare("DELETE FROM audit_events").run();
  });

  afterEach(() => {
    delete process.env.PRIMARY_USER_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFY_EMAIL_FROM;
    delete process.env.DB_BOOTSTRAP;
    delete process.env.LITESTREAM_SOCKET_PATH;
    delete process.env.LITESTREAM_STATE_PATH;
    vi.unstubAllGlobals();
  });

  it("routes a global connection failure to admin email fallback & Sentry", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    // Mock notify & sendNotification
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call global failure alert (keySource: "env")
    await health.alertConnectionFailure("pinecone", "env", "u_tenant", "API Key Invalid");

    // No delivery happens outside sendNotification's enabled-event gate. The lazy fallback callback
    // is passed alongside the normal direct bridge and invoked by sendNotification after gating.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "local",
        directBody: expect.stringContaining("API Key Invalid"),
        additionalDelivery: expect.any(Function)
      })
    );
    const options = sendNotificationSpy.mock.calls[0]?.[1];
    await options?.additionalDelivery?.();
    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ title: "pinecone connection failed", body: expect.stringContaining("API Key Invalid") }),
      expect.objectContaining({ prefs: expect.objectContaining({ email: "admin@socratic.trade", channels: ["email"] }) })
    );
  });

  it("routes a user connection failure to user notifications only (no fallback email)", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call user failure alert (keySource: "user")
    await health.alertConnectionFailure("pinecone", "user", "u_tenant", "User Key Expired");

    // User delivery is also centralized inside the gate; there is no operator fallback callback.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "u_tenant",
        directBody: expect.stringContaining("User Key Expired")
      })
    );
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
  });

  it("does not add the operator fallback when a preferred email target already exists", async () => {
    const { db, health, notifyMod, notificationsMod } = await load();
    db.setNotifyPrefs("local", { channels: ["email"], email: "preferred@socratic.trade" });
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    await health.alertConnectionFailure("finnhub", "env", null, "Provider unavailable");

    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledOnce();
    expect(sendNotificationSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        userId: "local",
        directBody: expect.stringContaining("Provider unavailable"),
        notifyDeps: expect.objectContaining({ config: expect.any(Object) })
      })
    );
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
  });

  it("records a storage-warning fallback delivery as sent without a duplicate", async () => {
    const { db, health } = await load();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      })
    );

    await health.alertStorageWarning("disk_space", "Persistent volume is nearly full");

    expect(calls).toEqual(["https://api.resend.com/emails"]);
    const event = db.listNotificationEvents("local", 10).find((candidate) => candidate.title === "Storage Warning: disk space");
    expect(event).toMatchObject({ status: "sent", error: undefined });
    const delivery = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'notification.delivery' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(delivery?.payload ?? "{}")).toMatchObject({
      notificationEventId: event?.id,
      status: "sent",
      results: [{ channel: "email", ok: true }]
    });
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

  it("/api/health reports the live recovery path degraded when Litestream cannot be observed", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.DB_BOOTSTRAP = "live";
    process.env.LITESTREAM_SOCKET_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}.sock`);
    process.env.LITESTREAM_STATE_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}`);

    const response = await healthRoute.GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.checks.storage).toMatchObject({
      litestreamState: "unknown",
      litestreamSource: "none",
      litestreamDegradedReasons: ["unavailable"]
    });
    expect(body.checks.storageDegraded).toBe(true);
  });
});
